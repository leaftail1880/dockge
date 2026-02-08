import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import { sync as commandExistsSync } from "command-exists";
import { spawn } from "node:child_process";
import * as os from "node:os";
import {
  PROGRESS_TERMINAL_ROWS,
  TERMINAL_COLS,
  TERMINAL_ROWS,
} from "../common/util-common";
import { DockgeServer } from "./dockge-server";
import { log } from "./log";
import { DockgeSocket } from "./util-server";
import { LimitQueue } from "./utils/limit-queue";

/**
 * Terminal for running commands, no user interaction
 */
export class Terminal {
  protected static terminalMap: Map<string, Terminal> = new Map();

  protected _ptyProcess?: pty.IPty;
  protected server: DockgeServer;
  protected buffer: LimitQueue<string> = new LimitQueue(100);
  protected _name: string;

  protected file: string;
  protected args: string | string[];
  protected cwd: string;
  protected callback?: (exitCode: number) => void;

  protected _rows: number = TERMINAL_ROWS;
  protected _cols: number = TERMINAL_COLS;

  public enableKeepAlive: boolean = false;
  protected keepAliveInterval?: NodeJS.Timeout;
  protected kickDisconnectedClientsInterval?: NodeJS.Timeout;

  protected socketList: Record<string, DockgeSocket> = {};

  constructor(
    server: DockgeServer,
    name: string,
    file: string,
    args: string | string[],
    cwd: string,
  ) {
    this.server = server;
    this._name = name;
    //this._name = "terminal-" + Date.now() + "-" + getCryptoRandomInt(0, 1000000);
    this.file = file;
    this.args = args;
    this.cwd = cwd;

    Terminal.terminalMap.set(this.name, this);
  }

  get rows() {
    return this._rows;
  }

  set rows(rows: number) {
    this._rows = rows;
    try {
      this.ptyProcess?.resize(this.cols, this.rows);
    } catch (e) {
      if (e instanceof Error) {
        log.debug("Terminal", "Failed to resize terminal: " + e.message);
      }
    }
  }

  get cols() {
    return this._cols;
  }

  set cols(cols: number) {
    this._cols = cols;
    log.debug("Terminal", `Terminal cols: ${this._cols}`); // Added to check if cols is being set when changing terminal size.
    try {
      this.ptyProcess?.resize(this.cols, this.rows);
    } catch (e) {
      if (e instanceof Error) {
        log.debug("Terminal", "Failed to resize terminal: " + e.message);
      }
    }
  }

  public start() {
    if (this._ptyProcess) {
      return;
    }

    this.kickDisconnectedClientsInterval = setInterval(() => {
      for (const socketID in this.socketList) {
        const socket = this.socketList[socketID];
        if (!socket.connected) {
          log.debug(
            "Terminal",
            "Kicking disconnected client " +
              socket.id +
              " from terminal " +
              this.name,
          );
          this.leave(socket);
        }
      }
    }, 60 * 1000) as NodeJS.Timeout;

    if (this.enableKeepAlive) {
      log.debug("Terminal", "Keep alive enabled for terminal " + this.name);

      // Close if there is no clients
      this.keepAliveInterval = setInterval(() => {
        const numClients = Object.keys(this.socketList).length;

        if (numClients === 0) {
          log.debug(
            "Terminal",
            "Terminal " + this.name + " has no client, closing...",
          );
          this.close();
        } else {
          log.debug(
            "Terminal",
            "Terminal " + this.name + " has " + numClients + " client(s)",
          );
        }
      }, 60 * 1000) as NodeJS.Timeout;
    } else {
      log.debug("Terminal", "Keep alive disabled for terminal " + this.name);
    }

    try {
      console.log("START", this.file, this.args);
      this._ptyProcess = pty.spawn(this.file, this.args, {
        name: this.name,
        cwd: this.cwd,
        cols: TERMINAL_COLS,
        rows: this.rows,
      });

      // On Data
      this._ptyProcess.onData((data) => {
        this.buffer.pushItem(data);

        for (const socketID in this.socketList) {
          const socket = this.socketList[socketID];
          socket.emitAgent("terminalWrite", this.name, data);
        }
      });

      // On Exit
      this._ptyProcess.onExit(this.exit);
    } catch (error) {
      if (error instanceof Error) {
        clearInterval(this.keepAliveInterval);

        log.error("Terminal", "Failed to start terminal: " + error.message);
        const exitCode = Number(error.message.split(" ").pop());
        this.exit({
          exitCode,
        });
      }
    }
  }

  /**
   * Exit event handler
   * @param res
   */
  protected exit = (res: { exitCode: number; signal?: number | undefined }) => {
    for (const socketID in this.socketList) {
      const socket = this.socketList[socketID];
      socket.emitAgent("terminalExit", this.name, res.exitCode);
    }

    // Remove all clients
    this.socketList = {};

    Terminal.terminalMap.delete(this.name);
    log.debug(
      "Terminal",
      "Terminal " + this.name + " exited with code " + res.exitCode,
    );

    clearInterval(this.keepAliveInterval);
    clearInterval(this.kickDisconnectedClientsInterval);

    if (this.callback) {
      this.callback(res.exitCode);
    }
  };

  public onExit(callback: (exitCode: number) => void) {
    this.callback = callback;
  }

  public join(socket: DockgeSocket) {
    this.socketList[socket.id] = socket;
  }

  public leave(socket: DockgeSocket) {
    delete this.socketList[socket.id];
  }

  public get ptyProcess() {
    return this._ptyProcess;
  }

  public get name() {
    return this._name;
  }

  /**
   * Get the terminal output string
   */
  getBuffer(): string {
    if (this.buffer.length === 0) {
      return "";
    }
    return this.buffer.join("");
  }

  close() {
    clearInterval(this.keepAliveInterval);
    // Send Ctrl+C to the terminal
    this.ptyProcess?.write("\x03");
  }

  /**
   * Get a running and non-exited terminal
   * @param name
   */
  public static getTerminal(name: string): Terminal | undefined {
    return Terminal.terminalMap.get(name);
  }

  public static getOrCreateTerminal(
    server: DockgeServer,
    name: string,
    file: string,
    args: string | string[],
    cwd: string,
  ): Terminal {
    // Since exited terminal will be removed from the map, it is safe to get the terminal from the map
    let terminal = Terminal.getTerminal(name);
    if (!terminal) {
      terminal = new Terminal(server, name, file, args, cwd);
    }
    return terminal;
  }

  public static exec(
    server: DockgeServer,
    socket: DockgeSocket | undefined,
    terminalName: string,
    file: string,
    args: string | string[],
    cwd: string,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      // check if terminal exists
      if (Terminal.terminalMap.has(terminalName)) {
        reject("Another operation is already running, please try again later.");
        return;
      }

      let terminal = new Terminal(server, terminalName, file, args, cwd);
      terminal.rows = PROGRESS_TERMINAL_ROWS;

      if (socket) {
        terminal.join(socket);
      }

      terminal.onExit((exitCode: number) => {
        resolve(exitCode);
      });
      terminal.start();
    });
  }

  public static getTerminalCount() {
    return Terminal.terminalMap.size;
  }
}

/**
 * Interactive terminal
 * Mainly used for container exec
 */
export class InteractiveTerminal extends Terminal {
  public write(input: string) {
    this.ptyProcess?.write(input);
  }

  resetCWD() {
    const cwd = process.cwd();
    this.ptyProcess?.write(`cd "${cwd}"\r`);
  }
}

/**
 * User interactive terminal that use bash or powershell with limited commands such as docker, ls, cd, dir
 */
export class MainTerminal extends InteractiveTerminal {
  constructor(server: DockgeServer, name: string) {
    let shell;

    // Throw an error if console is not enabled
    if (!server.config.enableConsole) {
      throw new Error("Console is not enabled.");
    }

    if (os.platform() === "win32") {
      if (commandExistsSync("pwsh.exe")) {
        shell = "pwsh.exe";
      } else {
        shell = "powershell.exe";
      }
    } else {
      shell = "bash";
    }
    super(server, name, shell, [], server.stacksDir);
  }

  public write(input: string) {
    super.write(input);
  }
}

/**
 * AttachTerminal class: attaches to container main process TTY and shows previous logs
 */
export class AttachTerminal extends InteractiveTerminal {
  protected serviceName: string;

  constructor(
    server: DockgeServer,
    name: string,
    serviceName: string,
    cwd: string,
  ) {
    super(
      server,
      name,
      "docker",
      ["compose", "attach", "--sig-proxy=false", serviceName],
      cwd,
    );
    this.serviceName = serviceName;
  }

  /**
   * Fetches logs and then starts attach session
   * Emits logs as if they're 'terminalWrite' output, then pipes attach stream
   * Must be called instead of .start()
   */
  public async startWithLogs() {
    try {
      const logs = await AttachTerminal.getContainerLogs(
        this.serviceName,
        this.cwd,
      );
      // Send logs to all attached sockets immediately
      for (const socketID in this.socketList) {
        const socket = this.socketList[socketID];
        socket.emitAgent("terminalWrite", this.name, logs);
      }
    } catch (e) {
      console.error("START WITH LOGS", e);
      // Optionally: ignore/log
    }

    // Proceed with normal attach flow
    this.start();
  }

  /**
   * Synchronously get logs (stdout+stderr) for container
   */
  private static getContainerLogs(
    serviceName: string,
    cwd: string,
  ): Promise<string> {
    return new Promise((resolve) => {
      // Get last 100 lines for scrolling UX, or adjust as needed
      const proc = spawn(
        "docker",
        ["compose", "logs", "--tail=100", serviceName],
        {
          cwd,
        },
      );
      let result = "";

      proc.stdout.on("data", (data) => (result += data.toString()));
      proc.stderr.on("data", (data) => (result += data.toString()));

      proc.on("close", () => {
        resolve(result);
      });

      proc.on("error", (error) => {
        console.error("Attach get logs error", error);
        resolve(""); // swallow errors, permit attach anyway
      });
    });
  }

  /**
   * Helper for others to get or create attach terminal and auto-start it
   * @returns AttachTerminal instance
   */
  public static async getOrCreateAttachTerminal(
    server: DockgeServer,
    name: string,
    serviceName: string,
    cwd: string,
  ): Promise<AttachTerminal> {
    // One attach session per terminal name (same as InteractiveTerminal)
    let instance = Terminal.getTerminal(name);
    if (!(instance instanceof AttachTerminal)) {
      instance = new AttachTerminal(server, name, serviceName, cwd);
    }
    // Cast for type
    const attachTerm = instance as AttachTerminal;
    await attachTerm.startWithLogs();
    return attachTerm;
  }
}
