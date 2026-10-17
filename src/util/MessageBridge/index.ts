
import {
  MessageBridgeMessage,
  castMessage,
} from "./types";

export type { MessageBridgeMessage } from "./types";
import { EventHandler } from "./event";
import { RequestHandler } from "./request";
import { SimpleStream, StreamHandler, StreamRequest } from "./stream";

export class MessageBridge {
  private _destroyed = false;
  private eventHandler: EventHandler
  private requestHandler: RequestHandler;
  private streamHandler: StreamHandler

  constructor(
    private sendMessage: (message: MessageBridgeMessage) => void,
    protected debug: boolean = false
  ){
    this.eventHandler = new EventHandler(sendMessage, debug);
    this.requestHandler = new RequestHandler(sendMessage, debug);
    this.streamHandler = new StreamHandler(sendMessage, debug);
  }

  async handleMessage(messageRaw: any): Promise<void>{
    const message = castMessage(messageRaw);
    if(this.eventHandler.handleMessage(message)) return;
    if(this.requestHandler.handleMessage(message)) return;
    if(this.streamHandler.handleMessage(message)) return;
  }
  destroy(){
    if(this._destroyed) return;
    this._destroyed = true;
    const error = new Error('Bridge destroyed');
    for(const pending of Object.values(this.requestHandler.pending)){
      pending.reject(error);
    }
    this.requestHandler.pending = {};
    for(const pending of Object.values(this.streamHandler.pending)){
      pending.reject(error);
    }
    this.streamHandler.pending = {};
    for(const stream of Object.values(this.streamHandler.active)){
      stream.onEnd.emit();
    }
    this.streamHandler.active = {};
  }

  sendBridge(path: string): BridgeRequest {
    if(this._destroyed) throw new Error('Bridge destroyed');
    return new BridgeRequest(this.sendStream(path), this.debug);
  }

  onBridge(path: string, handler: (session: BridgedSession)=>any){
    if(this._destroyed) throw new Error('Bridge destroyed');
    return this.onStream(path, (stream)=>{
      const session = new BridgedSession(stream, this.debug);
      return handler(session);
    });
  }

  sendStream(path: string): StreamRequest {
    if(this._destroyed) throw new Error('Bridge destroyed');
    return this.streamHandler.sendStream(path)
  }

  onStream(path: string, handler: (stream: SimpleStream)=>any){
    if(this._destroyed) throw new Error('Bridge destroyed');
    return this.streamHandler.onStream(path, handler)
  }

  sendRequest(path: string, body: any): Promise<any>{
    if(this._destroyed) throw new Error('Bridge destroyed');
    return this.requestHandler.sendRequest(path, body);
  }

  onRequest(path: string, handler: (data: any) => any){
    if(this._destroyed) throw new Error('Bridge destroyed');
    return this.requestHandler.onRequest(path, handler);
  }

  sendEvent(path: string, body: any){
    if(this._destroyed) throw new Error('Bridge destroyed');
    return this.eventHandler.sendEvent(path, body);
  }

  onEvent(path: string, handler: (data: any) => any){
    if(this._destroyed) throw new Error('Bridge destroyed');
    return this.eventHandler.onEvent(path, handler);
  }
}

export class BridgedSession extends MessageBridge {
  protected _stream: SimpleStream;

  constructor(stream: SimpleStream, debug?: boolean){
    super((msg)=>stream.sendData(msg), debug);
    this._stream = stream;
    stream.onData((data)=>this.handleMessage(data));
    stream.onEnd(()=>this.destroy());
  }

  get onEnd(){ return this._stream.onEnd; }
  sendEnd(){ this._stream.sendEnd(); }
}

export class BridgeRequest extends BridgedSession {
  private _request: StreamRequest;

  constructor(stream: StreamRequest, debug?: boolean){
    super(stream, debug);
    this._request = stream;
    stream.waitForOpen.catch(()=>{
      this.destroy();
    })
  }

  get waitForOpen(){ return this._request.waitForOpen; }
}

