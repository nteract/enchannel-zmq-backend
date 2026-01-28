/**
 * Jupyter Message Protocol (JMP) implementation using zeromq v6
 *
 * This module provides Jupyter wire protocol handling on top of zeromq v6's
 * async socket API, replacing the legacy jmp package which used zeromq v5.
 */
import * as crypto from "crypto";
import { EventEmitter } from "events";
import * as zmq from "zeromq";

/**
 * Jupyter message header as defined in the wire protocol.
 * @see https://jupyter-client.readthedocs.io/en/latest/messaging.html#the-wire-protocol
 */
export interface MessageHeader {
  msg_id?: string;
  msg_type?: string;
  username?: string;
  session?: string;
  date?: string;
  version?: string;
  subshell_id?: string | null;
}

/**
 * Parent header is a copy of the originating message's header,
 * or an empty object when no parent exists.
 */
export interface ParentHeader {
  msg_id?: string;
  msg_type?: string;
  username?: string;
  session?: string;
  date?: string;
  version?: string;
  subshell_id?: string | null;
  [key: string]: unknown;
}

/**
 * Metadata dictionary containing non-content message information.
 */
export interface MessageMetadata {
  [key: string]: unknown;
}

/**
 * Message content - structure varies by msg_type.
 */
export interface MessageContent {
  [key: string]: unknown;
}

export interface MessageProperties {
  idents?: Buffer[];
  header: MessageHeader;
  parent_header: ParentHeader;
  metadata: MessageMetadata;
  content: MessageContent;
  buffers?: Buffer[];
}

const DELIMITER = "<IDS|MSG>";

/**
 * Jupyter protocol Message class
 */
export class Message {
  idents: Buffer[];
  header: MessageHeader;
  parent_header: ParentHeader;
  metadata: MessageMetadata;
  content: MessageContent;
  buffers: Buffer[];

  constructor(properties?: Partial<MessageProperties>) {
    this.idents = properties?.idents || [];
    this.header = properties?.header || {};
    this.parent_header = properties?.parent_header || {};
    this.metadata = properties?.metadata || {};
    this.content = properties?.content || {};
    this.buffers = properties?.buffers || [];
  }

  /**
   * Encode the message for sending over ZMQ
   */
  encode(scheme: string, key: string): Buffer[] {
    const header = JSON.stringify(this.header);
    const parent_header = JSON.stringify(this.parent_header);
    const metadata = JSON.stringify(this.metadata);
    const content = JSON.stringify(this.content);

    let signature = "";
    if (key) {
      const hmac = crypto.createHmac(scheme, key);
      hmac.update(header);
      hmac.update(parent_header);
      hmac.update(metadata);
      hmac.update(content);
      signature = hmac.digest("hex");
    }

    const frames: Buffer[] = [
      ...this.idents,
      Buffer.from(DELIMITER),
      Buffer.from(signature),
      Buffer.from(header),
      Buffer.from(parent_header),
      Buffer.from(metadata),
      Buffer.from(content),
      ...this.buffers
    ];

    return frames;
  }

  /**
   * Decode a message from ZMQ frames
   */
  static decode(frames: Buffer[], scheme: string, key: string): Message {
    // Find the delimiter
    let delimiterIndex = -1;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].toString() === DELIMITER) {
        delimiterIndex = i;
        break;
      }
    }

    if (delimiterIndex === -1) {
      throw new Error("Missing message delimiter");
    }

    const idents = frames.slice(0, delimiterIndex);
    const signature = frames[delimiterIndex + 1].toString();
    const header = frames[delimiterIndex + 2].toString();
    const parent_header = frames[delimiterIndex + 3].toString();
    const metadata = frames[delimiterIndex + 4].toString();
    const content = frames[delimiterIndex + 5].toString();
    const buffers = frames.slice(delimiterIndex + 6);

    // Verify HMAC signature if key is provided
    if (key) {
      const hmac = crypto.createHmac(scheme, key);
      hmac.update(header);
      hmac.update(parent_header);
      hmac.update(metadata);
      hmac.update(content);
      const expectedSignature = hmac.digest("hex");

      if (signature !== expectedSignature) {
        throw new Error("Invalid message signature");
      }
    }

    return new Message({
      idents,
      header: JSON.parse(header),
      parent_header: JSON.parse(parent_header),
      metadata: JSON.parse(metadata),
      content: JSON.parse(content),
      buffers
    });
  }
}

type SocketType = "dealer" | "sub" | "pub" | "router" | "req" | "rep";

/**
 * JMP Socket wrapper around zeromq v6 sockets
 * Provides an event-emitter interface compatible with the legacy jmp API
 */
export class Socket extends EventEmitter {
  private socket: zmq.Dealer | zmq.Subscriber;
  private scheme: string;
  private key: string;
  private _identity: string = "";
  private _type: SocketType;
  private receiveLoop: Promise<void> | null = null;
  private closed: boolean = false;
  private monitorSocket: zmq.Dealer | zmq.Subscriber | null = null;

  constructor(socketType: SocketType, scheme: string = "sha256", key: string = "") {
    super();
    this._type = socketType;
    this.scheme = scheme;
    this.key = key;

    if (socketType === "sub") {
      this.socket = new zmq.Subscriber();
    } else {
      this.socket = new zmq.Dealer();
    }
  }

  get type(): SocketType {
    return this._type;
  }

  get identity(): string {
    return this._identity;
  }

  set identity(value: string) {
    this._identity = value;
    if (this.socket instanceof zmq.Dealer) {
      this.socket.routingId = value;
    }
  }

  /**
   * Subscribe to a topic (only for Subscriber sockets)
   */
  subscribe(topic: string = ""): void {
    if (this.socket instanceof zmq.Subscriber) {
      this.socket.subscribe(topic);
    }
  }

  /**
   * Connect to an endpoint
   */
  connect(endpoint: string): void {
    this.socket.connect(endpoint);
    // Start receiving messages
    this.startReceiveLoop();
  }

  /**
   * Start monitoring the socket
   */
  monitor(): void {
    this.monitorSocket = this.socket;
    // Emit connect event on next tick to simulate zmq monitoring
    setImmediate(() => {
      this.emit("connect");
    });
  }

  /**
   * Stop monitoring the socket
   */
  unmonitor(): void {
    this.monitorSocket = null;
  }

  /**
   * Start the receive loop
   */
  private startReceiveLoop(): void {
    if (this.receiveLoop) return;

    this.receiveLoop = (async () => {
      try {
        for await (const frames of this.socket) {
          if (this.closed) break;

          try {
            const buffers = frames.map((f: Buffer | Uint8Array) =>
              Buffer.isBuffer(f) ? f : Buffer.from(f)
            );
            const message = Message.decode(buffers, this.scheme, this.key);
            this.emit("message", message);
          } catch (err) {
            // If we can't decode as a Jupyter message, emit raw data
            // This handles cases like PUB/SUB where the first frame is the topic
            this.emit("message", { frames });
          }
        }
      } catch (err) {
        if (!this.closed) {
          this.emit("error", err);
        }
      }
    })();
  }

  /**
   * Send a message
   */
  send(message: Message): void {
    if (this.closed) return;

    const frames = message.encode(this.scheme, this.key);

    // Use Promise-based send but don't block
    (this.socket as zmq.Dealer).send(frames).catch((err) => {
      this.emit("error", err);
    });
  }

  /**
   * Close the socket
   */
  close(): void {
    this.closed = true;
    this.socket.close();
  }

  /**
   * Remove all listeners and cleanup
   */
  removeAllListeners(event?: string): this {
    super.removeAllListeners(event);
    return this;
  }
}
