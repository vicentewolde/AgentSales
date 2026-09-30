import { AppError, isAppError } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { isDbUnavailable, sqlStateOf, toDbError, withDbErrors } from "./errors.js";

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

/** Como lo lanza drizzle 0.45: SQL y parámetros en el mensaje, y el error del driver en `cause`. */
const drizzleWrapped = (cause: unknown, params: unknown[] = []) =>
  Object.assign(new Error(`Failed query: select 1\nparams: ${params.join(",")}`), {
    query: "select 1",
    params,
    cause,
  });

describe("isDbUnavailable", () => {
  it.each([
    ["ECONNREFUSED", withCode("connect ECONNREFUSED 127.0.0.1:5432", "ECONNREFUSED")],
    ["timeout del pool", new Error("timeout exceeded when trying to connect")],
    ["conexión cortada", new Error("Connection terminated unexpectedly")],
    ["SQLSTATE 08006", withCode("connection failure", "08006")],
    ["SQLSTATE 57P01", withCode("terminating connection due to administrator command", "57P01")],
    ["EHOSTUNREACH", withCode("connect EHOSTUNREACH", "EHOSTUNREACH")],
    ["cliente roto", new Error("Client has encountered a connection error and is not queryable")],
    ["envuelto por drizzle", drizzleWrapped(withCode("connect ECONNREFUSED", "ECONNREFUSED"))],
  ])("%s → sí", (_name, error) => {
    expect(isDbUnavailable(error)).toBe(true);
  });

  it.each([
    ["único violado", withCode("duplicate key value", "23505")],
    ["error de sintaxis", drizzleWrapped(withCode("syntax error", "42601"))],
    ["un valor que no es Error", "texto"],
    ["SQLSTATE 08P01 (violación de protocolo)", withCode("protocol violation", "08P01")],
    [
      "único violado con un parámetro que dice 'connection timeout'",
      drizzleWrapped(withCode("duplicate key value", "23505"), ["connection timeout"]),
    ],
    [
      "wrapper de drizzle sin causa, con 'Connection terminated' en los parámetros",
      drizzleWrapped(undefined, ["Connection terminated"]),
    ],
  ])("%s → no", (_name, error) => {
    expect(isDbUnavailable(error)).toBe(false);
  });
});

describe("toDbError", () => {
  it("convierte un fallo de conexión en DB_UNAVAILABLE reintentable, con el error del driver", () => {
    const driver = new Error("timeout exceeded when trying to connect");
    const result = toDbError(drizzleWrapped(driver, ["Calle Privada 123"]));
    expect(isAppError(result)).toBe(true);
    expect(result).toMatchObject({ code: "DB_UNAVAILABLE", retriable: true, cause: driver });
  });

  it("otro error de una consulta → DB_QUERY_FAILED con el SQLSTATE, no reintentable", () => {
    const driver = withCode("duplicate key value violates unique constraint", "23505");
    const result = toDbError(drizzleWrapped(driver, ["P001"]));
    expect(result).toMatchObject({
      code: "DB_QUERY_FAILED",
      retriable: false,
      cause: driver,
      details: { sqlState: "23505" },
    });
    expect(sqlStateOf(result)).toBe("23505");
  });

  it("los parámetros de la consulta (datos de clientes) no quedan en el error ni en su causa", () => {
    const params = ["Notas internas privadas", "Calle Privada 123"];
    for (const driver of [
      withCode("connect ECONNREFUSED", "ECONNREFUSED"),
      withCode("x", "23505"),
    ]) {
      const result = toDbError(drizzleWrapped(driver, params));
      const chain: string[] = [];
      for (let current: unknown = result; current instanceof Error; current = current.cause) {
        chain.push(current.message);
      }
      expect(chain.join("\n")).not.toContain("Privada");
    }
  });

  it("deja pasar tal cual los AppError y los errores ajenos a drizzle", () => {
    const duplicate = withCode("duplicate key value", "23505");
    expect(toDbError(duplicate)).toBe(duplicate);
    const appError = new AppError("LISTING_NOT_FOUND");
    expect(toDbError(appError)).toBe(appError);
  });
});

describe("withDbErrors", () => {
  it("devuelve el resultado o lanza el error traducido", async () => {
    await expect(withDbErrors(async () => 42)).resolves.toBe(42);
    await expect(
      withDbErrors(async () => {
        throw withCode("connect ECONNREFUSED", "ECONNREFUSED");
      }),
    ).rejects.toMatchObject({ code: "DB_UNAVAILABLE" });
  });
});

describe("sqlStateOf", () => {
  it("encuentra el SQLSTATE dentro del error de drizzle e ignora los códigos de red", () => {
    expect(sqlStateOf(drizzleWrapped(withCode("duplicate key value", "23505")))).toBe("23505");
    expect(sqlStateOf(withCode("connect ECONNREFUSED", "ECONNREFUSED"))).toBeUndefined();
    const epipe = Object.assign(withCode("write EPIPE", "EPIPE"), { syscall: "write" });
    expect(sqlStateOf(epipe)).toBeUndefined();
  });
});
