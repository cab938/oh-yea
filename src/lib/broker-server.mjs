import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const MAX_LINE_BYTES = 1024 * 1024;

function errorResponse(id, code, message, details) {
  return {
    id: id ?? null,
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

function writeLine(socket, payload) {
  if (!socket.destroyed) {
    socket.write(`${JSON.stringify(payload)}\n`);
  }
}

export class BrokerServer {
  constructor({
    socketPath,
    configProvider,
    capabilityCatalogProvider,
    serviceCatalogProvider,
    executor,
    operatorExecutor,
    logger,
  }) {
    this.socketPath = socketPath;
    this.configProvider = configProvider;
    this.capabilityCatalogProvider = capabilityCatalogProvider;
    this.serviceCatalogProvider = serviceCatalogProvider;
    this.executor = executor;
    this.operatorExecutor = operatorExecutor;
    this.logger = logger;
    this.server = null;
    this.connections = new Set();
  }

  async start() {
    await fs.mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.socketPath), 0o700);
    await fs.unlink(this.socketPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });

    this.server = net.createServer((socket) => this.#onConnection(socket));
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.socketPath);
    });
    await fs.chmod(this.socketPath, 0o600);
    this.logger?.add("info", "broker.started", "Broker is accepting local connections");
  }

  #onConnection(socket) {
    const connectionId = crypto.randomUUID();
    let buffer = "";
    this.connections.add(socket);
    this.logger?.add("info", "connection.opened", "Caller connection opened", {
      connectionId,
    });

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
        writeLine(
          socket,
          errorResponse(null, "REQUEST_TOO_LARGE", "Request exceeds 1 MiB"),
        );
        socket.destroy();
        return;
      }

      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          void this.#handleLine(socket, connectionId, line);
        }
      }
    });

    socket.on("error", (error) => {
      this.logger?.add("error", "connection.error", error.message, {
        connectionId,
      });
    });
    socket.on("close", () => {
      this.connections.delete(socket);
      this.logger?.add("info", "connection.closed", "Agent connection closed", {
        connectionId,
      });
    });
  }

  async #handleLine(socket, connectionId, line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      writeLine(
        socket,
        errorResponse(null, "INVALID_JSON", "Each input line must be valid JSON"),
      );
      return;
    }

    const id =
      typeof request?.id === "string" && request.id
        ? request.id
        : crypto.randomUUID();

    if (request?.operation === "services") {
      try {
        if (!this.serviceCatalogProvider) {
          throw Object.assign(new Error("Service discovery is unavailable"), { code: "DISCOVERY_UNAVAILABLE" });
        }
        const data = await this.serviceCatalogProvider();
        writeLine(socket, { id, ok: true, data, meta: { operation: "services" } });
      } catch (error) {
        writeLine(socket, errorResponse(id, error.code ?? "DISCOVERY_UNAVAILABLE", "Service discovery failed; the operator should check the service workflows"));
      }
      return;
    }

    if (request?.operation === "capabilities") {
      if (!this.capabilityCatalogProvider) {
        writeLine(
          socket,
          errorResponse(id, "DISCOVERY_UNAVAILABLE", "Capability discovery is unavailable"),
        );
        return;
      }
      const data = this.capabilityCatalogProvider();
      writeLine(socket, {
        id,
        ok: true,
        data,
        meta: { operation: "capabilities" },
      });
      this.logger?.add("info", "capabilities.discovered", "Capability contracts listed", {
        connectionId,
        requestId: id,
        capabilityCount: data.length,
      });
      return;
    }

    if (request?.operation === "inspect") {
      if (!this.operatorExecutor) {
        writeLine(
          socket,
          errorResponse(
            id,
            "INSPECTION_UNAVAILABLE",
            "The browser inspector is not available",
          ),
        );
        return;
      }
      try {
        const data = await this.operatorExecutor(request);
        writeLine(socket, {
          id,
          ok: true,
          data,
          meta: { operation: "inspect", command: request.command ?? "summary" },
        });
        this.logger?.add("info", "operator.inspected", "Browser inspected", {
          connectionId,
          requestId: id,
        });
      } catch (error) {
        writeLine(
          socket,
          errorResponse(
            id,
            error.code ?? "INSPECTION_FAILED",
            error.message,
          ),
        );
      }
      return;
    }

    const { authorizeRequest } = await import("./config.mjs");
    const authorization = authorizeRequest(this.configProvider(), request);

    if (!authorization.ok) {
      this.logger?.add(
        authorization.code === "UNAUTHORIZED" ? "warn" : "error",
        "request.rejected",
        authorization.message,
        {
          connectionId,
          requestId: id,
          capability: request?.capability,
        },
      );
      writeLine(
        socket,
        errorResponse(
          id,
          authorization.code,
          authorization.message,
          authorization.details,
        ),
      );
      return;
    }

    const capability = authorization.definition.name;
    this.logger?.add("info", "request.authorized", "Request authorized", {
      connectionId,
      requestId: id,
      capability,
    });

    try {
      const data = await this.executor({
        id,
        capability,
        definition: authorization.definition,
        input: authorization.input,
      });
      writeLine(socket, { id, ok: true, data, meta: { capability } });
      this.logger?.add("success", "request.completed", "Capability completed", {
        connectionId,
        requestId: id,
        capability,
      });
    } catch (error) {
      const code = error.code ?? "CAPABILITY_FAILED";
      this.logger?.add("error", "request.failed", error.message, {
        connectionId,
        requestId: id,
        capability,
      });
      writeLine(socket, errorResponse(id, code, error.message));
    }
  }

  async stop() {
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();

    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }

    await fs.unlink(this.socketPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
