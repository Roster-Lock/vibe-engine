import { createSimpleEmitter } from "../SimpleEvent"
import { uniqueId } from "../string";
import { MessageBridgeMessage } from "./types";

export class SimpleStream {
  state: "setup" | "failed" | "active" | "closed" = "setup"
  onData = createSimpleEmitter<[unknown]>()
  onEnd = createSimpleEmitter()
  constructor(
    private _sendData: (data: unknown)=>void,
    private _sendEnd: ()=>void,
  ){
    this.onEnd(()=>{
      if(this.state === "active"){
        this.state = "closed"
      }
    })
  }
  sendData(data: any){
    if(this.state === "setup") throw new Error(
      'Cannot send on stream during setup. Defer with Promise.resolve().then(() => stream.sendData(...))'
    );
    if(this.state === "failed") throw new Error(
      'Cannot send on stream after failed to connect.'
    )
    if(this.state === "closed") throw new Error(
      'Cannot send on stream after closed.'
    )
    this._sendData(data);
  }

  sendEnd(){
    if(this.state === "setup") throw new Error(
      'Cannot send on stream during setup. Defer with Promise.resolve().then(() => stream.sendEnd())'
    );
    if(this.state === "failed") throw new Error(
      'Cannot end on stream after failed to connect.'
    )
    if(this.state === "closed") throw new Error(
      'Cannot end on stream after closed.'
    )
    this._sendEnd();
    this.onEnd.emit();
  }
}

export class StreamRequest extends SimpleStream {
  waitForOpen: Promise<void>;
  _resolveOpen!: () => void;
  _rejectOpen!: (reason: any) => void;

  constructor(sendData: (data: any)=>void, sendEnd: ()=>void){
    super(sendData, sendEnd);
    this.waitForOpen = new Promise((resolve, reject) => {
      this._resolveOpen = resolve;
      this._rejectOpen = reject;
    });
  }
}


export class StreamHandler {
  listeners: Record<string, (message: SimpleStream) => any> = {};
  pending: Record<string, {
    stream: SimpleStream,
    resolve: (value: any) => void,
    reject: (reason: any) => void,
  }> = {};
  active: Record<string, SimpleStream> = {}

  constructor(
    private sendMessage: (message: MessageBridgeMessage)=>void,
    private debug: boolean,
  ){}

  handleMessage(message: MessageBridgeMessage){
    switch(message.messageType){
      case "stream-attempt": {
        try {
          if(this.active[message.id])
            throw new Error("Duplicate Stream Id")
          const handler = this.listeners[message.path];
          if(!handler)
            throw new Error(`no request listener at ${message.path}`);

          // handler runs now so it can attach listeners (onData/onEnd)
          // before the peer is told it's safe to send anything.
          const stream = this.createStream(message.id);
          const result = handler(stream);
          stream.state = "active";
          this.active[message.id] = stream;
          this.sendMessage({
            id: message.id,
            messageType: "stream-response",
            value: "start"
          });
          Promise.resolve(result).catch((e)=>{
            this.debug && console.warn("stream error handling suppressed", e);
          });
        }catch(e) {
          this.sendMessage({
            id: message.id,
            messageType: "stream-response",
            value: "error"
          });
        }
        return true;
      }
      case "stream-response": {
        const pending = this.pending[message.id];
        if(!pending)
          throw new Error(`no pending stream for ${message.id}`);
        if(this.active[message.id])
          throw new Error("Duplicate Stream Id")
        delete this.pending[message.id];
        if(message.value === "error"){
          pending.reject("Failed to establish stream");
          return true;
        }
        this.active[message.id] = pending.stream;
        pending.resolve(pending.stream);
        return true;
      }
      case "stream-data": {
        const active = this.active[message.id];
        if(!active) throw new Error(`no active stream for ${message.id}`);
        active.onData.emit(message.value);
        return true;
      }
      case "stream-end": {
        const active = this.active[message.id];
        if(!active) throw new Error(`no active stream for ${message.id}`);
        delete this.active[message.id]
        active.onEnd.emit();
        return true;
      }
    }
    return false;

  }
  private createStreamRequest(streamId: string){
    const stream = new StreamRequest(
      (data)=>{
        if(!(streamId in this.active)){
          throw new Error("Stream isn't active")
        }
        this.sendMessage({
          id: streamId,
          messageType: "stream-data",
          value: data
        })
      },
      ()=>{
        if(!(streamId in this.active)){
          throw new Error("Stream isn't active")
        }
        delete this.active[streamId];
        this.sendMessage({
          id: streamId,
          messageType: "stream-end"
        });
      }
    );
    return stream;
  }
  private createStream(streamId: string){
    const stream = new SimpleStream(
      (data)=>{
        if(!(streamId in this.active)){
          throw new Error("Stream isn't active")
        }
        this.sendMessage({
          id: streamId,
          messageType: "stream-data",
          value: data
        })
      },
      ()=>{
        if(!(streamId in this.active)){
          throw new Error("Stream isn't active")
        }
        delete this.active[streamId];
        this.sendMessage({
          id: streamId,
          messageType: "stream-end"
        });
      }
    );
    return stream;
  }

  sendStream(path: string): StreamRequest {
    const id = uniqueId();
    const stream = this.createStreamRequest(id);
    stream.state = "setup";
    this.pending[id] = {
      stream,
      resolve: ()=>{
        stream.state = "active";
        stream._resolveOpen();
      },
      reject: (reason)=>{
        stream.state = "failed";
        stream._rejectOpen(reason);
      }
    };
    Promise.resolve().then(()=>this.sendMessage({ id, path, messageType: 'stream-attempt' }));
    return stream;
  }
  onStream(path: string, handler: (stream: SimpleStream)=>any){
    if(path in this.listeners){
      throw new Error(`Duplicate Path: ${path}`);
    }
    this.listeners[path] = handler;
    return () => {
      if(this.listeners[path] === handler) delete this.listeners[path];
    };
  }
}

