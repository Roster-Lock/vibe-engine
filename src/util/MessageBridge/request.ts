import { uniqueId } from "../string";
import { MessageBridgeMessage } from "./types";

export class RequestHandler {
  listeners: Record<string, (message: unknown) => any> = {};
  pending: Record<string, {
    resolve: (value: any) => void,
    reject: (reason: any) => void,
  }> = {};

  constructor(
    private sendMessage: (message: MessageBridgeMessage)=>void,
    private debug: boolean,
  ){}

  handleMessage(message: MessageBridgeMessage){
    switch(message.messageType){
      case "request": {
        try {
          const handler = this.listeners[message.path];
          if(!handler) throw new Error(`no request listener at ${message.path}`);
          Promise.resolve().then(async ()=>{
            try {
              const result = await handler(message.value);
              this.sendMessage({
                id: message.id,
                messageType: "response",
                valueType: "result",
                value: result
              });
            }catch(e){
              this.sendMessage({
                id: message.id,
                messageType: "response",
                valueType: "error",
                value: typeof e === "string" ? e : e instanceof Error ? e.message : "Unknown Error"
              });
            }
          })
        }catch(e) {
          this.sendMessage({
            id: message.id,
            messageType: "response",
            valueType: "error",
            value: typeof e === "string" ? e : e instanceof Error ? e.message : "Unknown Error"
          });
        }
        return true;
      }
      case "response": {
        try {
          const pending = this.pending[message.id];
          if(!pending) throw new Error(`no pending request for ${message.id}`);
          delete this.pending[message.id];
          if(message.valueType === "error"){
            // The sending side always serializes an error down to a plain string (see the
            // "request" case below) - a raw string can't cross this bridge as an Error instance
            // either way (postMessage/WebSocket JSON round-trips lose the prototype), so rebuild
            // one here instead of rejecting with the bare string. Consumers throughout this
            // codebase assume `(e as Error).message` works on a sendRequest() rejection - without
            // this, that reads `undefined` instead of the real failure reason.
            pending.reject(new Error(typeof message.value === "string" ? message.value : String(message.value)));
          } else {
            pending.resolve(message.value);
          }
        }catch(e) {
          this.debug && console.error("error handling message", e);
        }
        return true;
      }
    }
    return false;
  }

  sendRequest(path: string, body: any): Promise<any>{
    return new Promise((resolve, reject)=>{
      const id = uniqueId();
      this.pending[id] = { resolve, reject };
      this.sendMessage({
        id,
        path,
        messageType: "request",
        value: body
      });
    });
  }

  onRequest(path: string, handler: (data: any) => any){
    if(path in this.listeners){
      throw new Error(`Duplicate Path: ${path}`);
    }
    this.listeners[path] = handler;
    return () => {
      if(this.listeners[path] === handler) delete this.listeners[path];
    };
  }
}
