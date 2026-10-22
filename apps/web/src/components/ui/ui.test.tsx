// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Alert } from "./Alert.js";
import { Badge } from "./Badge.js";
import { Button, ButtonLink } from "./Button.js";
import { Card } from "./Card.js";
import { EmptyState } from "./EmptyState.js";
import { Field, Input, Select, Textarea } from "./Field.js";
import { PageHeader } from "./PageHeader.js";
import { Loading } from "./Spinner.js";
import { BADGE_TONE, buttonClasses, cx } from "./styles.js";
import { Table } from "./Table.js";

// F9.5-T01: los componentes base del sistema visual. Se prueba lo que cambia el comportamiento o
// la accesibilidad (nombres, roles, estados), no el detalle de las clases.

afterEach(cleanup);

describe("cx", () => {
  it("junta las clases y deja fuera las vacías", () => {
    expect(cx("a", false, null, undefined, "", "b")).toBe("a b");
  });
});

describe("Button", () => {
  it("es un botón de tipo button por defecto y avisa el clic", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Guardar</Button>);
    const button = screen.getByRole("button", { name: "Guardar" });
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("respeta el tipo submit", () => {
    render(<Button type="submit">Enviar</Button>);
    expect(screen.getByRole("button", { name: "Enviar" }).getAttribute("type")).toBe("submit");
  });

  it("cargando: desactivado, ocupado y con el mismo nombre", () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Publicar
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Publicar" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("desactivado conserva su motivo en el título", () => {
    render(
      <Button disabled title="El post está archivado.">
        Aprobar
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Aprobar" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("El post está archivado.");
    expect(button.getAttribute("aria-busy")).toBeNull();
  });

  it("cada variante tiene sus colores y el tamaño su relleno", () => {
    expect(buttonClasses("primary")).toContain("bg-brand-700");
    expect(buttonClasses("danger")).toContain("bg-danger-700");
    expect(buttonClasses("secondary")).toContain("border-line-strong");
    // El fantasma no tiene fondo (solo al pasar el mouse).
    expect(buttonClasses("ghost")).not.toMatch(/(^|\s)bg-/);
    expect(buttonClasses("primary", "sm")).toContain("py-1.5");
    expect(buttonClasses("primary", "md")).toContain("py-2");
  });

  it("ButtonLink es un enlace con forma de botón", () => {
    render(
      <MemoryRouter>
        <ButtonLink to="/importar">Importar</ButtonLink>
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "Importar" });
    expect(link.getAttribute("href")).toBe("/importar");
    expect(link.className).toContain("border-line-strong");
  });
});

describe("Badge", () => {
  it("dice el estado con texto y el punto es decorativo", () => {
    render(<Badge tone="success">Lista</Badge>);
    const badge = screen.getByText("Lista");
    expect(badge.className).toContain(BADGE_TONE.success.badge);
    const dot = badge.querySelector("[aria-hidden='true']");
    expect(dot?.className).toContain(BADGE_TONE.success.dot);
    expect(badge.textContent).toBe("Lista");
  });

  it("sin punto", () => {
    render(
      <Badge tone="danger" dot={false}>
        Falló
      </Badge>,
    );
    expect(screen.getByText("Falló").querySelector("[aria-hidden='true']")).toBeNull();
  });
});

describe("Card", () => {
  it("como sección con título es una región con ese nombre", () => {
    render(
      <Card as="section" title="Publicaciones" description="Lo programado y lo publicado">
        <p>contenido</p>
      </Card>,
    );
    const region = screen.getByRole("region", { name: "Publicaciones" });
    expect(region.textContent).toContain("Lo programado y lo publicado");
    expect(screen.getByRole("heading", { name: "Publicaciones", level: 2 })).toBeTruthy();
  });

  it("aria-label manda sobre el título", () => {
    render(
      <Card as="section" aria-label="Textos" title="Textos por red">
        x
      </Card>,
    );
    expect(screen.getByRole("region", { name: "Textos" })).toBeTruthy();
  });

  it("como div no es región y muestra sus acciones", () => {
    render(
      <Card title="Editar" actions={<Button>Cerrar</Button>}>
        x
      </Card>,
    );
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeTruthy();
  });
});

describe("PageHeader", () => {
  it("el título es el encabezado de la página, con volver, descripción y acciones", () => {
    render(
      <MemoryRouter>
        <PageHeader
          title="Propiedades"
          meta={<Badge>Borrador</Badge>}
          description="Tus avisos"
          back={{ to: "/contenido", label: "Contenido" }}
          actions={<Button>Nueva</Button>}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Propiedades" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Contenido" }).getAttribute("href")).toBe("/contenido");
    expect(screen.getByText("Tus avisos")).toBeTruthy();
    expect(screen.getByText("Borrador")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Nueva" })).toBeTruthy();
  });
});

describe("EmptyState y Loading", () => {
  it("el estado vacío dice qué falta y cómo seguir", () => {
    render(
      <EmptyState
        title="Todavía no hay propiedades."
        description="Cárgalas desde Importar."
        action={<Button>Importar</Button>}
      />,
    );
    expect(screen.getByText("Todavía no hay propiedades.")).toBeTruthy();
    expect(screen.getByText("Cárgalas desde Importar.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Importar" })).toBeTruthy();
  });

  it("cargando, con su texto", () => {
    render(<Loading>Cargando propiedades…</Loading>);
    expect(screen.getByText("Cargando propiedades…")).toBeTruthy();
  });
});

describe("Alert", () => {
  it("lleva el rol que le dan, con título y contenido", () => {
    render(
      <Alert role="alert" tone="danger" title="No se pudo guardar">
        Reintenta en un momento.
      </Alert>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("No se pudo guardar");
    expect(alert.textContent).toContain("Reintenta en un momento.");
  });

  it("sin rol no se anuncia", () => {
    render(<Alert tone="info">Un dato</Alert>);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Un dato")).toBeTruthy();
  });
});

describe("Field", () => {
  it("la etiqueta envuelve al control (asociación implícita), con ayuda y error", () => {
    render(
      <Field label="Tema" hint="Una línea" error="Falta el tema">
        <Input name="topic" />
      </Field>,
    );
    const input = screen.getByLabelText(/^Tema/) as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.className).toContain("w-full");
    expect(screen.getByText("Una línea")).toBeTruthy();
    expect(screen.getByText("Falta el tema")).toBeTruthy();
  });

  it("con htmlFor, la etiqueta apunta al control", () => {
    render(
      <Field label="Comuna" htmlFor="comuna">
        <Select id="comuna" width="auto">
          <option value="">Todos</option>
        </Select>
      </Field>,
    );
    const select = screen.getByLabelText("Comuna");
    expect(select.tagName).toBe("SELECT");
    expect(select.className).not.toContain("w-full");
  });

  it("el área de texto", () => {
    render(
      <Field label="Brief">
        <Textarea name="brief" defaultValue="hola" />
      </Field>,
    );
    expect((screen.getByLabelText("Brief") as HTMLTextAreaElement).value).toBe("hola");
  });
});

describe("Table", () => {
  it("una tabla con los estilos del panel", () => {
    render(
      <Table aria-label="Cargas">
        <thead>
          <tr>
            <th>Archivo</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>enero.xlsx</td>
          </tr>
        </tbody>
      </Table>,
    );
    const table = screen.getByRole("table", { name: "Cargas" });
    expect(table.className).toContain("ui-table");
    expect(screen.getByRole("cell", { name: "enero.xlsx" })).toBeTruthy();
  });
});
