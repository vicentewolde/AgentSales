import { AppError, isAppError } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import {
  isDbUnavailable,
  isUniqueViolation,
  sqlStateOf,
  toDbError,
  withDbErrors,
} from "./errors.js";

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
  it("convierte un fallo de conexión en DB_UNAVAILABLE reintentable, con un resumen del driver", () => {
    const driver = withCode("connect ECONNREFUSED 127.0.0.1:5432", "ECONNREFUSED");
    const result = toDbError(drizzleWrapped(driver, ["Calle Privada 123"]));
    expect(isAppError(result)).toBe(true);
    expect(result).toMatchObject({
      code: "DB_UNAVAILABLE",
      retriable: true,
      cause: { message: "Error de la base de datos (ECONNREFUSED)", code: "ECONNREFUSED" },
    });
  });

  it("otro error de una consulta → DB_QUERY_FAILED con el SQLSTATE, no reintentable", () => {
    const driver = Object.assign(withCode("duplicate key value", "23505"), {
      constraint: "listings_broker_id_external_ref_unique",
      table: "listings",
    });
    const result = toDbError(drizzleWrapped(driver, ["P001"]));
    expect(result).toMatchObject({
      code: "DB_QUERY_FAILED",
      retriable: false,
      details: { sqlState: "23505" },
      cause: {
        code: "23505",
        constraint: "listings_broker_id_external_ref_unique",
        table: "listings",
      },
    });
    expect(sqlStateOf(result)).toBe("23505");
  });

  it("no guarda datos de clientes: ni params, ni detail, ni el mensaje del driver", () => {
    const privateData = "Calle Privada 123";
    const drivers = [
      withCode(`connect ECONNREFUSED ${privateData}`, "ECONNREFUSED"),
      Object.assign(withCode("null value in column", "23502"), {
        detail: `Failing row contains (${privateData}, notas internas)`,
      }),
      withCode(`invalid input syntax for type numeric: "${privateData}"`, "22P02"),
    ];
    for (const driver of drivers) {
      const result = toDbError(drizzleWrapped(driver, [privateData]));
      const chain: unknown[] = [];
      for (let current: unknown = result; current instanceof Error; current = current.cause) {
        chain.push({ ...current, message: current.message });
      }
      expect(JSON.stringify(chain)).not.toContain("Privada");
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

describe("isUniqueViolation", () => {
  const CONSTRAINT = "listings_broker_id_external_ref_unique";
  const unique = (constraint?: string) =>
    Object.assign(withCode("duplicate key value", "23505"), constraint ? { constraint } : {});

  it("reconoce el 23505 de su único: crudo, envuelto por drizzle o ya traducido por toDbError", () => {
    expect(isUniqueViolation(unique(CONSTRAINT), CONSTRAINT)).toBe(true);
    expect(isUniqueViolation(drizzleWrapped(unique(CONSTRAINT)), CONSTRAINT)).toBe(true);
    expect(isUniqueViolation(toDbError(drizzleWrapped(unique(CONSTRAINT))), CONSTRAINT)).toBe(true);
  });

  it("no confunde otro único, otro SQLSTATE ni un 23505 sin constraint", () => {
    expect(isUniqueViolation(unique("brokers_slug_unique"), CONSTRAINT)).toBe(false);
    expect(isUniqueViolation(withCode("check violation", "23514"), CONSTRAINT)).toBe(false);
    // Sin `constraint` (otro driver o versión) no se puede saber cuál chocó: no es un conflicto
    // reintentable sino DB_QUERY_FAILED. Si pasara con pg o PGlite, la suite de contrato lo detecta.
    expect(isUniqueViolation(unique(), CONSTRAINT)).toBe(false);
  });
});
