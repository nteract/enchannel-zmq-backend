import { Subject } from "rxjs";
import { take, toArray } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import { v4 as uuid } from "uuid";

import {
  createMainChannelFromSockets,
  createSocket,
  getUsername,
  JupyterConnectionInfo,
  verifiedConnect,
  ZMQType
} from "../src";

import { EventEmitter } from "events";
import { Socket as _Socket, Message } from "../src/jmp";

import { JupyterMessage, MessageType } from "@nteract/messaging";

interface Sockets {
  [id: string]: MockSocket;
}

// Mock a socket that behaves like our jmp Socket
class MockSocket extends EventEmitter {
  send = jest.fn();
  type: string;
  identity: string = "";
  private _closed = false;

  constructor(type: string = "dealer") {
    super();
    this.type = type;
  }

  monitor(): void {
    // Simulated - emit connect on next tick
  }

  unmonitor(): void {
    // No-op
  }

  connect(_url: string): void {
    // No-op for mock
  }

  close(): void {
    this._closed = true;
  }

  subscribe(_topic: string): void {
    // No-op for mock (only relevant for sub sockets)
  }
}

describe("createSocket", () => {
  test("creates a JMP socket on the channel with identity", async () => {
    const config = {
      signature_scheme: "hmac-sha256",
      key: "5ca1ab1e-c0da-aced-cafe-c0ffeefacade",
      ip: "127.0.0.1",
      transport: "tcp",
      iopub_port: 9009
    } as JupyterConnectionInfo;
    const identity = uuid();

    const socket = await createSocket("iopub", identity, config);
    expect(socket).not.toBeNull();
    expect(socket.identity).toBe(identity);
    expect(socket.type).toBe(ZMQType.frontend.iopub);
    socket.close();
  });
});

describe("verifiedConnect", () => {
  test("verifiedConnect monitors the socket", async () => {
    const emitter = new EventEmitter();

    const socket = {
      type: "hokey",
      monitor: jest.fn(),
      unmonitor: jest.fn(),
      close: jest.fn(),
      on: jest.fn(emitter.on.bind(emitter)),
      emit: jest.fn(emitter.emit.bind(emitter)),
      connect: jest.fn(() => {})
    };

    const p = verifiedConnect(
      socket as unknown as _Socket,
      "tcp://127.0.0.1:8945"
    );
    expect(socket.monitor).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledWith("tcp://127.0.0.1:8945");
    expect(socket.unmonitor).toHaveBeenCalledTimes(0);

    // Test that we unmonitor after connected
    socket.emit("connect");

    await p;
    expect(socket.unmonitor).toHaveBeenCalledTimes(1);
  });

  test("verifiedConnect monitors the socket properly even on fast connect", async () => {
    const emitter = new EventEmitter();

    const socket = {
      type: "hokey",
      monitor: jest.fn(),
      unmonitor: jest.fn(),
      close: jest.fn(),
      on: jest.fn(emitter.on.bind(emitter)),
      emit: jest.fn(emitter.emit.bind(emitter)),
      connect: jest.fn(() => {
        emitter.emit("connect");
      })
    };

    verifiedConnect(socket as unknown as _Socket, "tcp://127.0.0.1:8945");
    expect(socket.monitor).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(socket.unmonitor).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledWith("tcp://127.0.0.1:8945");
  });
});

describe("getUsername", () => {
  test("relies on environment variables for username with a specific ordering", () => {
    expect(getUsername()).toEqual("username");

    process.env.USERNAME = "TEST1";
    expect(getUsername()).toEqual("TEST1");
    process.env.LNAME = "TEST2";
    expect(getUsername()).toEqual("TEST2");
    process.env.USER = "TEST3";
    expect(getUsername()).toEqual("TEST3");
    process.env.LOGNAME = "TEST4";
    expect(getUsername()).toEqual("TEST4");
  });

  test(`when no environment variables are set, use literally 'username', which
      comes from the classic jupyter notebook`, () => {
    expect(getUsername()).toEqual("username");
  });

  beforeEach(() => {
    delete process.env.LOGNAME;
    delete process.env.USER;
    delete process.env.LNAME;
    delete process.env.USERNAME;
  });

  afterEach(() => {
    delete process.env.LOGNAME;
    delete process.env.USER;
    delete process.env.LNAME;
    delete process.env.USERNAME;
  });
});

describe("createMainChannelFromSockets", () => {
  test("basic creation", () => {
    const sockets = {
      hokey: new MockSocket() as unknown as _Socket
    };
    // TODO: This shouldn't work silently if the socket doesn't actually behave
    // like an actual socket
    // NOTE: RxJS doesn't error with the fromEvent until there is at least one
    //       subscriber, which also tells me we might have the wrong behavior
    //       here as it should go ahead and subscribe unconditionally...
    const channels = createMainChannelFromSockets(sockets);

    expect(channels).toBeInstanceOf(Subject);
  });

  test("simple one channel message passing from 'socket' to channels", async () => {
    const hokeySocket = new MockSocket();
    const sockets = {
      shell: hokeySocket as unknown as _Socket
    };

    const channels = createMainChannelFromSockets(sockets);
    expect(channels).toBeInstanceOf(Subject);

    const messages = [{ a: 1 }, { a: 2 }, { b: 3 }];

    const p = firstValueFrom(
      (channels as unknown as Subject<any>).pipe(take(messages.length), toArray())
    );

    for (const message of messages) {
      hokeySocket.emit("message", message);
    }

    const modifiedMessages = await p;
    expect(modifiedMessages).toEqual(
      messages.map(msg => ({ ...msg, channel: "shell" }))
    );
  });

  test("handles multiple socket routing underneath", async () => {
    const shellSocket = new MockSocket();
    const iopubSocket = new MockSocket();
    const sockets = {
      shell: shellSocket as unknown as _Socket,
      iopub: iopubSocket as unknown as _Socket
    };

    const channels = createMainChannelFromSockets(sockets);

    const p = firstValueFrom(
      (channels as unknown as Subject<any>).pipe(take(2), toArray())
    );

    shellSocket.emit("message", { yolo: false });
    iopubSocket.emit("message", { yolo: true });

    const modifiedMessages = await p;
    expect(modifiedMessages).toEqual([
      { channel: "shell", yolo: false },
      { channel: "iopub", yolo: true }
    ]);
  });

  test("propagates header information through", async () => {
    const shellSocket = new MockSocket();
    const iopubSocket = new MockSocket();
    const sockets = {
      shell: shellSocket as unknown as _Socket,
      iopub: iopubSocket as unknown as _Socket
    };

    const channels = createMainChannelFromSockets(sockets, {
      session: "spinning",
      username: "dj"
    });

    const responses = firstValueFrom(
      (channels as unknown as Subject<any>).pipe(take(2), toArray())
    );

    channels.next({ channel: "shell" } as JupyterMessage<any>);

    expect(shellSocket.send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: {},
        header: expect.objectContaining({
          session: "spinning",
          username: "dj"
        }),
        metadata: {},
        parent_header: {}
      })
    );

    channels.next({
      channel: "shell",
      content: {
        applesauce: "mcgee"
      },
      header: {
        version: "3",
        msg_type: "random" as MessageType,
        date: new Date().toISOString(),
        msg_id: "XYZ",

        // NOTE: we'll be checking that we use the set username for the
        //       channels, no overrides
        username: "kitty"
      }
    } as JupyterMessage);

    expect(shellSocket.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: {
          applesauce: "mcgee"
        },
        header: expect.objectContaining({
          msg_type: "random",
          session: "spinning",
          username: "dj",
          msg_id: "XYZ",
          date: expect.any(String),
          version: "3"
        }),
        metadata: {},
        parent_header: {}
      })
    );

    shellSocket.emit("message", { yolo: false });
    iopubSocket.emit("message", { yolo: true });

    const modifiedMessages = await responses;

    expect(modifiedMessages).toEqual([
      { channel: "shell", yolo: false },
      { channel: "iopub", yolo: true }
    ]);
  });
});
