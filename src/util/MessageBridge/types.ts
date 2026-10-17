
export interface ProtocolHandler {
  handleMessage(message: MessageBridgeMessage): boolean
}


export type EventMessage = {
  messageType: "event",
  path: string,
  value: any,
};

export type RequestMessage = {
  id: string,
  messageType: "request",
  path: string,
  value: any,
};

export type ResponseMessage = {
  id: string,
  messageType: "response",
  valueType: "result" | "error",
  value: any,
};

export type StreamAttemptMessage = {
  id: string,
  messageType: "stream-attempt"
  path: string,
}

export type StreamResponseMessage = {
  id: string,
  messageType: "stream-response",
  value: "start" | "error"
}

export type StreamDataMessage = {
  id: string,
  messageType: "stream-data",
  value: any
}

export type StreamEndMessage = {
  id: string,
  messageType: "stream-end"
}


export type MessageBridgeMessage = (
  | EventMessage
  | RequestMessage
  | ResponseMessage
  | StreamAttemptMessage
  | StreamResponseMessage
  | StreamDataMessage
  | StreamEndMessage
);

export function castMessage(message: any): MessageBridgeMessage{
  if(typeof message !== "object"){
    throw new Error("expecting a complex type");
  }
  if(Array.isArray(message)){
    throw new Error("expecting a complex type");
  }
  if(message === null){
    throw new Error("expecting a complex type");
  }

  if(typeof message.messageType !== "string"){
    throw new Error("expecting a message type");
  }

  if(message.messageType === "event"){
    if(typeof message.path !== "string"){
      throw new Error("expecting a path");
    }
    if(typeof message.value === "undefined"){
      throw new Error("expecting a value");
    }
    return { messageType: "event", path: message.path, value: message.value };
  }

  if(message.messageType === "request"){
    if(typeof message.id !== "string"){
      throw new Error("expecting an id");
    }
    if(typeof message.path !== "string"){
      throw new Error("expecting a path");
    }
    if(typeof message.value === "undefined"){
      throw new Error("expecting a value");
    }
    return { id: message.id, messageType: "request", path: message.path, value: message.value };
  }

  if(message.messageType === "response"){
    if(typeof message.id !== "string"){
      throw new Error("expecting an id");
    }
    if(typeof message.valueType !== "string"){
      throw new Error("expecting a value type");
    }
    if(message.valueType !== "result" && message.valueType !== "error"){
      throw new Error("invalid value type");
    }
    if(typeof message.value === "undefined"){
      throw new Error("expecting a value");
    }
    return { id: message.id, messageType: "response", valueType: message.valueType, value: message.value };
  }

  if(message.messageType === "stream-attempt"){
    if(typeof message.id !== "string"){
      throw new Error("expecting an id");
    }
    if(typeof message.path !== "string"){
      throw new Error("expecting a path");
    }
    return { id: message.id, messageType: "stream-attempt", path: message.path }
  }
  if(message.messageType === "stream-response"){
    if(typeof message.id !== "string"){
      throw new Error("expecting an id");
    }
    if(!["start", "error"].includes(message.value)){
      throw new Error("expecting a value as \"start\" or \"error\"");
    }
    return { id: message.id, messageType: "stream-response", value: message.value }
  }
  if(message.messageType === "stream-data"){
    if(typeof message.id !== "string"){
      throw new Error("expecting an id");
    }
    if(typeof message.value === "undefined"){
      throw new Error("expecting a value");
    }
    return { id: message.id, messageType: "stream-data", value: message.value }
  }
  if(message.messageType === "stream-end"){
    if(typeof message.id !== "string"){
      throw new Error("expecting an id");
    }
    return { id: message.id, messageType: "stream-end" }
  }

  throw new Error("invalid message type");
}
