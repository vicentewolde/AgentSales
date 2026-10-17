import { describe, expect, it } from "vitest";
import { PASSWORD_MASK, passwordKeystroke } from "./context.js";

// F7-T06: la contraseña de `agentsales login` muestra un punto por carácter, nunca la letra.

describe("la contraseña en la terminal", () => {
  it("un punto por carácter, también al pegar; Enter termina", () => {
    let step = passwordKeystroke("", "a");
    expect(step).toEqual({ value: "a", echo: PASSWORD_MASK, done: null });
    step = passwordKeystroke(step.value, "ñb3");
    expect(step).toEqual({ value: "añb3", echo: PASSWORD_MASK.repeat(3), done: null });
    expect(passwordKeystroke(step.value, "\r")).toEqual({ value: "añb3", echo: "", done: "enter" });
  });

  it("borrar quita el último punto; con nada escrito no borra el texto de la pregunta", () => {
    expect(passwordKeystroke("ab", "\u007f")).toEqual({ value: "a", echo: "\b \b", done: null });
    expect(passwordKeystroke("", "\u007f")).toEqual({ value: "", echo: "", done: null });
  });

  it("Ctrl+C cancela; las flechas y otros controles no cuentan", () => {
    expect(passwordKeystroke("ab", "\u0003").done).toBe("cancel");
    expect(passwordKeystroke("ab", "\u001b[D")).toEqual({ value: "ab", echo: "", done: null });
    expect(passwordKeystroke("ab", "\t")).toEqual({ value: "ab", echo: "", done: null });
  });

  it("nunca escribe la contraseña en la terminal", () => {
    const step = passwordKeystroke("", "secreto-largo");
    expect(step.echo).not.toMatch(/[a-z]/);
  });
});
