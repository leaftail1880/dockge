import fs, { promises as fsAsync } from "fs";
import path from "path";
import childProcessAsync from "promisify-child-process";
import { format } from "util";
import yaml from "yaml";
import {
  acceptedComposeFileNames,
  acceptedComposeOverrideFileNames,
  COMBINED_TERMINAL_COLS,
  COMBINED_TERMINAL_ROWS,
  CREATED_FILE,
  CREATED_STACK,
  EXITED,
  getCombinedTerminalName,
  getComposeTerminalName,
  getContainerExecTerminalName,
  RUNNING,
  TERMINAL_ROWS,
  UNKNOWN,
} from "../common/util-common";
import { DockgeServer } from "./dockge-server";
import { log } from "./log";
import { Settings } from "./settings";
import { InteractiveTerminal, Terminal } from "./terminal";
import { DockgeSocket, fileExists, ValidationError } from "./util-server";

export interface DeleteOptions {
  deleteStackFiles: boolean;
}

interface StackJson {
  Name: string; // 'lushway',
  Status: string; // 'exited(1), running(3)',
  ConfigFiles: string; // 'D:\\dockge\\stacks\\ha\\compose.yaml'
}

interface ContainerJson {
  Command: string; //`"/bin/sh -c 'node --…"`
  CreatedAt: string; // "2026-02-08 18:20:20 +0300 MSK",
  ID: string; // "51ebfac4a8ae",
  Image: string; // "ghcr.io/lushway/telegram-discord",
  Labels: string; // "com.docker.compose.container-number=1,com.docker.compose.project.working_dir=D:\\dockge\\stacks\\ha,com.docker.compose.project=lushway ... more
  LocalVolumes: string; // "0"
  Mounts: string; // ""
  Names: string; // "lushway-telegram-discord",
  Networks: string; // "lushway_default"
  Platform?: null;
  Ports: string; // "8081/tcp",
  RunningFor: string; // "18 hours ago",
  Size: string; // "0B"
  State: string; // "running",
  Status: string; // "Up 18 hours",
  ExitCode?: number;
  Health: string;
  Name: string;
  Project: string;
  Publishers: object[];
  Service: string;
}

export class Stack {
  name: string;
  protected _status: number = UNKNOWN;
  protected _composeYAML?: string;
  protected _composeENV?: string;
  protected _composeOverrideYAML?: string;
  protected _configFilePath?: string;
  protected _composeFileName: string = "compose.yaml";
  protected _composeOverrideFileName: string = "compose.override.yaml";
  protected server: DockgeServer;

  protected combinedTerminal?: Terminal;

  // File content cache
  private fileCache = new Map<string, string>();

  // Static cache for managed stacks
  protected static managedStackList: Map<string, Stack> = new Map();

  constructor(
    server: DockgeServer,
    name: string,
    composeYAML?: string,
    composeENV?: string,
    composeOverrideYAML?: string,
    skipFSOperations = false,
  ) {
    this.name = name;
    this.server = server;

    // Set initial values
    if (composeYAML !== undefined) {
      this._composeYAML = composeYAML;
      this.fileCache.set("compose", composeYAML);
    }
    if (composeENV !== undefined) {
      this._composeENV = composeENV;
      this.fileCache.set("env", composeENV);
    }
    if (composeOverrideYAML !== undefined) {
      this._composeOverrideYAML = composeOverrideYAML;
      this.fileCache.set("override", composeOverrideYAML);
    }

    if (!skipFSOperations) {
      this._composeFileName = this.findComposeFileName();
      this._composeOverrideFileName = this.findComposeOverrideFileName();
    }
  }

  private findComposeFileName(): string {
    for (const filename of acceptedComposeFileNames) {
      if (fs.existsSync(path.join(this.path, filename))) {
        return filename;
      }
    }
    return "compose.yaml";
  }

  private findComposeOverrideFileName(): string {
    for (const filename of acceptedComposeOverrideFileNames) {
      if (fs.existsSync(path.join(this.path, filename))) {
        return filename;
      }
    }
    return "compose.override.yaml";
  }

  async toJSON(endpoint: string): Promise<object> {
    const primaryHostname = await this.getPrimaryHostname(endpoint);
    let obj = this.toSimpleJSON(endpoint);
    return {
      ...obj,
      composeYAML: this.composeYAML,
      composeENV: this.composeENV,
      composeOverrideYAML: this.composeOverrideYAML,
      primaryHostname,
    };
  }

  toSimpleJSON(endpoint: string): object {
    return {
      name: this.name,
      status: this._status,
      tags: [],
      isManagedByDockge: this.isManagedByDockge,
      composeFileName: this._composeFileName,
      composeOverrideFileName: this._composeOverrideFileName,
      endpoint,
    };
  }

  /**
   * Get the status of the stack from `docker compose ps --format json`
   */
  async ps(): Promise<ContainerJson[]> {
    const res = await childProcessAsync.spawn(
      "docker",
      this.getComposeOptions("ps", "--format", "json"),
      {
        encoding: "utf-8",
        cwd: this.path,
      },
    );

    if (!res.stdout || !(res.stdout as string).trim()) {
      return [];
    }

    return Stack.parseDockerJsonLines<ContainerJson>(res.stdout.toString());
  }

  get isManagedByDockge(): boolean {
    return fs.existsSync(this.path) && fs.statSync(this.path).isDirectory();
  }

  get status(): number {
    return this._status;
  }

  validate() {
    // Check name, allows [a-z][0-9] _ - only
    if (!this.name.match(/^[a-z0-9_-]+$/)) {
      throw new ValidationError(
        "Stack name can only contain [a-z][0-9] _ - only",
      );
    }

    // Check YAML format
    yaml.parse(this.composeYAML);

    // Check override YAML format if it exists
    if (this.composeOverrideYAML && this.composeOverrideYAML.trim() !== "") {
      yaml.parse(this.composeOverrideYAML);
    }

    this.validateEnvFormat();
  }

  private validateEnvFormat(): void {
    const lines = this.composeENV.split("\n");
    // Check if the .env is able to pass docker-compose
    // Prevent "setenv: The parameter is incorrect"
    // It only happens when there is one line and it doesn't contain "="
    if (lines.length === 1 && !lines[0].includes("=") && lines[0].length > 0) {
      throw new ValidationError("Invalid .env format");
    }
  }

  private getFileContent(
    filePath: string,
    cacheKey: string,
    defaultValue: string = "",
  ): string {
    if (!this.fileCache.has(cacheKey)) {
      try {
        this.fileCache.set(cacheKey, fs.readFileSync(filePath, "utf-8"));
      } catch (e) {
        this.fileCache.set(cacheKey, defaultValue);
      }
    }
    return this.fileCache.get(cacheKey)!;
  }

  get composeYAML(): string {
    return this.getFileContent(
      path.join(this.path, this._composeFileName),
      "compose",
    );
  }

  get composeENV(): string {
    return this.getFileContent(path.join(this.path, ".env"), "env");
  }

  get composeOverrideYAML(): string {
    return this.getFileContent(
      path.join(this.path, this._composeOverrideFileName),
      "override",
    );
  }

  get composeOverrideFileName(): string {
    return this._composeOverrideFileName;
  }

  get path(): string {
    return path.join(this.server.stacksDir, this.name);
  }

  get fullPath(): string {
    const dir = this.path;
    return path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
  }

  /**
   * Save the stack to the disk
   * @param isAdd
   */
  async save(isAdd: boolean) {
    this.validate();

    const dir = this.path;

    // Check if the name is used if isAdd
    if (isAdd) {
      if (await fileExists(dir)) {
        throw new ValidationError("Stack name already exists");
      }

      // Create the stack folder
      await fsAsync.mkdir(dir);
    } else {
      if (!(await fileExists(dir))) {
        throw new ValidationError("Stack not found");
      }
    }

    await this.writeStackFiles();
  }

  private async writeStackFiles(): Promise<void> {
    // Write or overwrite the compose.yaml
    await this.writeFileIfNotEmpty(
      path.join(this.path, this._composeFileName),
      this.composeYAML,
    );

    // Write or overwrite the .env
    const envPath = path.join(this.path, ".env");
    await this.writeFileIfExistsOrNotEmpty(envPath, this.composeENV);

    // Write or overwrite the compose override file
    const overridePath = path.join(this.path, this._composeOverrideFileName);
    await this.writeFileIfExistsOrNotEmpty(
      overridePath,
      this.composeOverrideYAML,
    );

    // Clear cache after writing to ensure fresh reads
    this.fileCache.clear();
  }

  private async writeFileIfExistsOrNotEmpty(
    filePath: string,
    content: string,
  ): Promise<void> {
    if ((await fileExists(filePath)) || content.trim() !== "") {
      await fsAsync.writeFile(filePath, content);
    }
  }

  private async writeFileIfNotEmpty(
    filePath: string,
    content: string,
  ): Promise<void> {
    await fsAsync.writeFile(filePath, content);
  }

  async deploy(socket: DockgeSocket): Promise<number> {
    return this.runComposeCommand(
      socket,
      "up",
      ["-d", "--remove-orphans"],
      "deploy",
    );
  }

  async delete(socket: DockgeSocket, options: DeleteOptions): Promise<number> {
    const exitCode = await this.runComposeCommand(
      socket,
      "down",
      ["--remove-orphans"],
      `delete ${this.name}`,
    );

    if (options.deleteStackFiles) {
      await fsAsync.rm(this.path, {
        recursive: true,
        force: true,
      });
    }

    return exitCode;
  }

  async forceDelete(socket: DockgeSocket): Promise<number> {
    // Force delete with extra volume removal
    const terminalName = getComposeTerminalName(socket.endpoint, this.name);
    const exitCode = await Terminal.exec(
      this.server,
      socket,
      terminalName,
      "docker",
      this.getComposeOptions("down", "-v", "--remove-orphans"),
      this.path,
    );

    if (exitCode !== 0) {
      throw new Error(this.getErrorMessage(`force delete ${this.name}`));
    }

    // Remove the stack folder
    await fsAsync.rm(this.path, {
      recursive: true,
      force: true,
    });

    return exitCode;
  }

  async updateStatus() {
    const statusList = await Stack.getStatusList();
    this._status = statusList.get(this.name) || UNKNOWN;
  }

  /**
   * Checks if a compose file exists in the specified directory.
   * @async
   * @static
   * @param {string} stacksDir - The directory of the stack.
   * @param {string} filename - The name of the directory to check for the compose file.
   * @returns {Promise<boolean>} A promise that resolves to a boolean indicating whether any compose file exists.
   */
  static async composeFileExists(
    stacksDir: string,
    filename: string,
  ): Promise<boolean> {
    const filenamePath = path.join(stacksDir, filename);

    for (const composeFileName of acceptedComposeFileNames) {
      const composeFile = path.join(filenamePath, composeFileName);
      if (await fileExists(composeFile)) {
        return true;
      }
    }
    return false;
  }

  static async getStackList(
    server: DockgeServer,
    useCacheForManaged = false,
  ): Promise<Map<string, Stack>> {
    if (useCacheForManaged && this.managedStackList.size > 0) {
      return this.managedStackList;
    }

    const stackList = await this.scanStacksDirectory(server);

    // Cache by copying
    this.managedStackList = new Map(stackList);

    await this.updateStackStatuses(server, stackList);

    return stackList;
  }

  private static async scanStacksDirectory(
    server: DockgeServer,
  ): Promise<Map<string, Stack>> {
    const stackList = new Map<string, Stack>();
    const stacksDir = server.stacksDir;

    try {
      const filenameList = await fsAsync.readdir(stacksDir);

      for (const filename of filenameList) {
        try {
          const stat = await fsAsync.stat(path.join(stacksDir, filename));
          if (!stat.isDirectory()) continue;

          if (!(await Stack.composeFileExists(stacksDir, filename))) continue;

          const stack = await this.getStack(server, filename);
          stack._status = CREATED_FILE;
          stackList.set(filename, stack);
        } catch (e) {
          if (e instanceof Error) {
            log.warn(
              "getStackList",
              `Failed to get stack ${filename}, error: ${e.message}`,
            );
          }
        }
      }
    } catch (e) {
      log.error("scanStacksDirectory", `Failed to read stacks directory: ${e}`);
    }

    return stackList;
  }

  private static async updateStackStatuses(
    server: DockgeServer,
    stackList: Map<string, Stack>,
  ): Promise<void> {
    try {
      const res = await childProcessAsync.spawn(
        "docker",
        ["compose", "ls", "--all", "--format", "json"],
        { encoding: "utf-8" },
      );

      if (!res.stdout) return;

      const composeList = JSON.parse(res.stdout.toString()) as StackJson[];

      for (const composeStack of composeList) {
        let stack = stackList.get(composeStack.Name);

        if (!stack) {
          if (composeStack.Name === "dockge") continue;

          stack = new Stack(server, composeStack.Name);
          stackList.set(composeStack.Name, stack);
        }

        stack._status = await this.statusConvert(composeStack);
        stack._configFilePath = composeStack.ConfigFiles;
      }
    } catch (e) {
      log.error("updateStackStatuses", `Failed to update stack statuses: ${e}`);
    }
  }

  /**
   * Get the status list, it will be used to update the status of the stacks
   */
  static async getStatusList(): Promise<Map<string, number>> {
    const statusList = new Map<string, number>();

    try {
      const res = await childProcessAsync.spawn(
        "docker",
        ["compose", "ls", "--all", "--format", "json"],
        { encoding: "utf-8" },
      );

      if (!res.stdout) return statusList;

      const composeList = JSON.parse(res.stdout.toString());

      for (const composeStack of composeList) {
        statusList.set(
          composeStack.Name,
          await this.statusConvert(composeStack),
        );
      }
    } catch (e) {
      log.error("getStatusList", `Failed to get status list: ${e}`);
    }

    return statusList;
  }

  /**
   * Get the detailed status of a single compose stack, listing every container in the stack
   */
  static async getSingleComposeStatus(
    composeName: string,
  ): Promise<ContainerJson[] | null> {
    try {
      const res = await childProcessAsync.spawn(
        "docker",
        [
          "ps",
          "-a",
          "--filter",
          `label=com.docker.compose.project=${composeName}`,
          "--format",
          "json",
        ],
        { encoding: "utf-8" },
      );

      if (!res.stdout) return null;

      return this.parseDockerJsonLines<ContainerJson>(res.stdout.toString());
    } catch (error) {
      log.debug(
        "GET SINGLE COMPOSE STATUS",
        format(composeName, "Failed to parse JSON from res.stdout", error),
      );
      return null;
    }
  }

  /**
   * Check if the compose stack is exited cleanly
   */
  static async isComposeExitClean(composeStack: StackJson): Promise<number> {
    const expectedContainersExited = parseInt(
      composeStack.Status.split("(")[1].split(")")[0],
    );
    let cleanlyExitedContainerCount = 0;

    const composeStatus = await this.getSingleComposeStatus(composeStack.Name);

    if (composeStatus === null) return EXITED;

    for (const containerStatus of composeStatus) {
      const status = containerStatus.Status.trim();

      if (status.startsWith("exited", 0)) {
        if (status.startsWith("exited (0)", 0)) {
          cleanlyExitedContainerCount++;
        } else {
          return EXITED;
        }
      }
    }

    return cleanlyExitedContainerCount === expectedContainersExited
      ? RUNNING
      : EXITED;
  }

  /**
   * Convert the status string from `docker compose ls` to the status number
   */
  static async statusConvert(composeStack: StackJson): Promise<number> {
    if (composeStack.Status.startsWith("created")) {
      return CREATED_STACK;
    } else if (composeStack.Status.includes("exited")) {
      return await this.isComposeExitClean(composeStack);
    } else if (composeStack.Status.startsWith("running")) {
      return RUNNING;
    } else {
      return UNKNOWN;
    }
  }

  static async getStack(
    server: DockgeServer,
    stackName: string,
    skipFSOperations = false,
  ): Promise<Stack> {
    const dir = path.join(server.stacksDir, stackName);

    if (!skipFSOperations) {
      if (
        !(await fileExists(dir)) ||
        !(await fsAsync.stat(dir)).isDirectory()
      ) {
        const stackList = await this.getStackList(server, true);
        const stack = stackList.get(stackName);

        if (stack) return stack;
        throw new ValidationError("Stack not found " + stackName);
      }
    }

    const stack = skipFSOperations
      ? new Stack(server, stackName, undefined, undefined, undefined, true)
      : new Stack(server, stackName);

    stack._status = UNKNOWN;
    stack._configFilePath = path.resolve(dir);
    return stack;
  }

  getComposeOptions(command: string, ...extraOptions: string[]): string[] {
    const options = ["compose", command, ...extraOptions];

    if (fs.existsSync(path.join(this.server.stacksDir, "global.env"))) {
      options.splice(1, 0, "--env-file", "../global.env");
      if (fs.existsSync(path.join(this.path, ".env"))) {
        options.splice(1, 0, "--env-file", "./.env");
      }
    }

    return options;
  }

  async start(socket: DockgeSocket): Promise<number> {
    return this.runComposeCommand(
      socket,
      "up",
      ["-d", "--remove-orphans"],
      "start",
    );
  }

  async stop(socket: DockgeSocket): Promise<number> {
    return this.runComposeCommand(socket, "stop", [], "stop");
  }

  async restart(socket: DockgeSocket): Promise<number> {
    return this.runComposeCommand(socket, "restart", [], "restart");
  }

  async down(socket: DockgeSocket): Promise<number> {
    return this.runComposeCommand(socket, "down", [], "down");
  }

  async update(socket: DockgeSocket): Promise<number> {
    let exitCode = await this.runComposeCommand(socket, "pull", [], "pull");

    await this.updateStatus();

    if (this.status === RUNNING) {
      exitCode = await this.runComposeCommand(
        socket,
        "up",
        ["-d", "--remove-orphans"],
        "restart",
      );

      exitCode = await this.runTerminalExec(
        socket,
        "docker",
        ["image", "prune", "--all", "--force"],
        "prune images",
      );
    }

    return exitCode;
  }

  async joinCombinedTerminal(socket: DockgeSocket): Promise<void> {
    const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
    const terminal = Terminal.getOrCreateTerminal(
      this.server,
      terminalName,
      "docker",
      this.getComposeOptions("logs", "-f", "--tail", "100"),
      this.path,
    );
    terminal.enableKeepAlive = true;
    terminal.rows = COMBINED_TERMINAL_ROWS;
    terminal.cols = COMBINED_TERMINAL_COLS;
    terminal.join(socket);
    terminal.start();
  }

  async leaveCombinedTerminal(socket: DockgeSocket): Promise<void> {
    const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
    const terminal = Terminal.getTerminal(terminalName);
    terminal?.leave(socket);
  }

  async joinContainerTerminal(
    socket: DockgeSocket,
    serviceName: string,
    shell: string = "sh",
    index: number = 0,
  ): Promise<void> {
    const terminalName = getContainerExecTerminalName(
      socket.endpoint,
      this.name,
      serviceName,
      index,
    );
    let terminal = Terminal.getTerminal(terminalName);

    if (!terminal) {
      terminal = new InteractiveTerminal(
        this.server,
        terminalName,
        "docker",
        this.getComposeOptions("exec", serviceName, shell),
        this.path,
      );
      terminal.rows = TERMINAL_ROWS;
      log.debug("joinContainerTerminal", "Terminal created");
    }

    terminal.join(socket);
    terminal.start();
  }

  async getServiceStatusList(): Promise<Map<string, Array<object>>> {
    const statusList = new Map<string, Array<object>>();

    try {
      const containers = await this.ps();

      for (const container of containers) {
        if (!statusList.has(container.Service)) {
          statusList.set(container.Service, []);
        }
        statusList.get(container.Service)?.push({
          status: container.Health || container.State,
          name: container.Name,
        });
      }
    } catch (e) {
      log.error("getServiceStatusList", e);
    }

    return statusList;
  }

  async startService(
    socket: DockgeSocket,
    serviceName: string,
  ): Promise<number> {
    return this.runComposeCommand(
      socket,
      "up",
      ["-d", serviceName],
      `start service ${serviceName}`,
    );
  }

  async stopService(
    socket: DockgeSocket,
    serviceName: string,
  ): Promise<number> {
    return this.runComposeCommand(
      socket,
      "stop",
      [serviceName],
      `stop service ${serviceName}`,
    );
  }

  async restartService(
    socket: DockgeSocket,
    serviceName: string,
  ): Promise<number> {
    return this.runComposeCommand(
      socket,
      "restart",
      [serviceName],
      `restart service ${serviceName}`,
    );
  }

  // ============ HELPER METHODS ============

  private async getPrimaryHostname(endpoint: string): Promise<string> {
    let primaryHostname = await Settings.get("primaryHostname");

    if (!primaryHostname) {
      if (!endpoint) {
        primaryHostname = "localhost";
      } else {
        try {
          primaryHostname = new URL("https://" + endpoint).hostname;
        } catch (e) {
          primaryHostname = "localhost";
        }
      }
    }

    return primaryHostname;
  }

  static parseDockerJsonLines<T>(output: string): T[] {
    return output
      .split("\n")
      .filter((e) => !!e.trim())
      .map((e) => JSON.parse(e.trim()));
  }

  private async runComposeCommand(
    socket: DockgeSocket,
    command: string,
    args: string[],
    actionDescription: string,
  ): Promise<number> {
    const fullArgs = this.getComposeOptions(command, ...args);
    return this.runTerminalExec(socket, "docker", fullArgs, actionDescription);
  }

  private async runTerminalExec(
    socket: DockgeSocket,
    command: string,
    args: string[],
    actionDescription: string,
  ): Promise<number> {
    const terminalName = getComposeTerminalName(socket.endpoint, this.name);
    const exitCode = await Terminal.exec(
      this.server,
      socket,
      terminalName,
      command,
      args,
      this.path,
    );

    if (exitCode !== 0) {
      throw new Error(this.getErrorMessage(actionDescription));
    }

    return exitCode;
  }

  private getErrorMessage(actionDescription: string): string {
    return `Failed to ${actionDescription}, please check the terminal output for more information.`;
  }
}
