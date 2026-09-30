import { AppError, isAppError } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { isDbUnavailable, sqlStateOf, toDbError, withDbErrors } from "./errors.js";

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

/** Como lo lanza drizzle 0.45: el error del driver va en `cause`. */
const drizzleWrapped = (cause: unknown) =>
  Object.assign(new Error("Failed query: select 1\nparams: "), { cause });

describe("isDbUnavailable", () => {
  it.each([
    ["ECONNREFUSED", withCode("connect ECONNREFUSED 127.0.0.1:5432", "ECONNREFUSED")],
    ["timeout del pool", new Error("timeout exceeded when trying to connect")],
    ["conexión cortada", new Error("Connection terminated unexpectedly")],
    ["SQLSTATE 08006", withCode("connection failure", "08006")],
    ["SQLSTATE 57P01", withCode("terminating connection due to administrator command", "57P01")],
    ["envuelto por drizzle", drizzleWrapped(withCode("connect ECONNREFUSED", "ECONNREFUSED"))],
  ])("%s → sí", (_name, error) => {
    expect(isDbUnavailable(error)).toBe(true);
  });

  it.each([
    ["único violado", withCode("duplicate key value", "23505")],
    ["error de sintaxis", drizzleWrapped(withCode("syntax error", "42601"))],
    ["un valor que no es Error", "texto"],
  ])("%s → no", (_name, error) => {
    expect(isDbUnavailable(error)).toBe(false);
  });
});

describe("toDbError", () => {
  it("convierte un fallo de conexión en DB_UNAVAILABLE reintentable, con la causa", () => {
    const original = drizzleWrapped(new Error("timeout exceeded when trying to connect"));
    const result = toDbError(original);
    expect(isAppError(result)).toBe(true);
    expect(result).toMatchObject({ code: "DB_UNAVAILABLE", retriable: true, cause: original });
  });

  it("deja pasar tal cual los demás errores, incluidos los AppError", () => {
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
