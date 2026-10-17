import {
  MessageBridgeMessage,
} from "./types";

export class EventHandler {
  listeners: Record<string, Array<(message: MessageBridgeMessage) => any>> = {};

  constructor(
    private sendMessage: (message: MessageBridgeMessage)=>void,
    private debug: boolean,
  ){}

  handleMessage(message: MessageBridgeMessage): boolean {
    switch(message.messageType){
      case "event": {
        try {
          const handlers = this.listeners[message.path];
          if(!handlers) throw new Error(`no event listener at ${message.path}`);
          Promise.resolve().then(async ()=>{
            for(const handler of handlers) {
              await handler(message.value);
            }
          })
        }catch(e) {
          this.debug && console.error("error handling message", e);
        }
        return true;
      }
    }
    return false;
  }

  sendEvent(path: string, body: any){
    this.sendMessage({
      path,
      messageType: "event",
      value: body
    });
  }

  onEvent(path: string, handler: (data: any) => any){
    const listeners = this.listeners[path] || [];
    listeners.push(handler);
    this.listeners[path] = listeners;
    return () => {
      this.listeners[path] = (this.listeners[path] || []).filter(l => l !== handler);
    };
  }

}