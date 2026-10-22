import { type BrokerSheetDraft, parseUsdAmount, slugify } from "@agentsales/core";
import { type ChangeEvent, type FormEvent, useId, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { BrokerFields } from "../../queries/brokers.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Alert } from "../ui/Alert.js";
import { Button } from "../ui/Button.js";
import { Field, Input } from "../ui/Field.js";
import { FILE_INPUT } from "../ui/styles.js";

/** Los colores de un corredor que no eligió los suyos (F9.5-T16): azul tinta y cobre. */
export const DEFAULT_PRIMARY_COLOR = "#233B78";
export const DEFAULT_SECONDARY_COLOR = "#C96F24";

/** Lo que manda el formulario a `POST /brokers`. */
export type CreateBrokerValues = BrokerFields & {
  slug: string;
  name: string;
  brandName: string;
  primaryColor: string;
  kind?: "broker" | "brand";
};

type Values = {
  name: string;
  brandName: string;
  slug: string;
  primaryColor: string;
  secondaryColor: string;
  whatsapp: string;
  email: string;
  instagramHandle: string;
  website: string;
  tone: string;
  fixedHashtags: string;
  cap: string;
  operatorOwned: boolean;
  brand: boolean;
};

const EMPTY: Values = {
  name: "",
  brandName: "",
  slug: "",
  primaryColor: "",
  secondaryColor: "",
  whatsapp: "",
  email: "",
  instagramHandle: "",
  website: "",
  tone: "",
  fixedHashtags: "",
  cap: "",
  operatorOwned: false,
  brand: false,
};

const optional = (text: string) => (text.trim() === "" ? null : text.trim());

/** Los campos de las opciones avanzadas que trae la planilla: si trae alguno, se abren. */
const ADVANCED: readonly (keyof BrokerSheetDraft)[] = [
  "primaryColor",
  "secondaryColor",
  "whatsapp",
  "email",
  "instagramHandle",
  "website",
  "tone",
];

/**
 * Crear un corredor (F9.5-T16): a la vista solo el nombre y la marca; el identificador se arma solo
 * desde la marca (y se puede cambiar); lo demás va en **Opciones avanzadas**, plegado, con los
 * colores por defecto si quedan vacíos. **Llenar desde una planilla** lee la hoja Corredor (sin
 * guardar nada) y deja los datos en el formulario para revisarlos antes de crear.
 */
export function CreateBrokerForm({
  pending,
  error,
  onSubmit,
  parsing,
  parseError,
  onParseTemplate,
}: {
  pending: boolean;
  error: Error | null;
  onSubmit: (values: CreateBrokerValues) => void;
  parsing: boolean;
  parseError: Error | null;
  /** Lee la hoja Corredor de la planilla; responde el borrador o falla (sin guardar nada). */
  onParseTemplate: (file: File, done: (draft: BrokerSheetDraft) => void) => void;
}) {
  const id = useId();
  const [values, setValues] = useState<Values>(EMPTY);
  // Mientras no se toque, el identificador sigue a la marca.
  const [slugTouched, setSlugTouched] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [capError, setCapError] = useState<string | null>(null);
  const [filled, setFilled] = useState<{ file: string; draft: BrokerSheetDraft } | null>(null);

  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues((current) => ({
      ...current,
      [key]: value,
      ...(key === "brandName" && !slugTouched ? { slug: slugify(String(value)) } : {}),
    }));
  const text =
    (key: keyof Values) =>
    (event: ChangeEvent<HTMLInputElement>): void =>
      set(key, event.target.value);

  const pickTemplate = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    onParseTemplate(file, (draft) => {
      setValues((current) => ({
        ...current,
        name: draft.name ?? "",
        brandName: draft.brandName ?? "",
        slug: slugify(draft.brandName ?? ""),
        primaryColor: draft.primaryColor ?? "",
        // Como en la carga: el secundario vacío toma el primario de la planilla.
        secondaryColor: draft.secondaryColor ?? draft.primaryColor ?? "",
        whatsapp: draft.whatsapp ?? "",
        email: draft.email ?? "",
        instagramHandle: draft.instagramHandle ?? "",
        website: draft.website ?? "",
        tone: draft.tone ?? "",
        fixedHashtags: draft.fixedHashtags.join(" "),
      }));
      setSlugTouched(false);
      if (draft.fixedHashtags.length > 0 || ADVANCED.some((key) => draft[key] !== null)) {
        setAdvanced(true);
      }
      setFilled({ file: file.name, draft });
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Un tope mal escrito no se manda como "sin tope": el tope controla el gasto (regla de core).
    let cap: number | null;
    try {
      cap = parseUsdAmount(values.cap);
    } catch {
      setAdvanced(true);
      setCapError("Escribe un monto en dólares, por ejemplo 20 o 12,50 (vacío: sin tope)");
      return;
    }
    setCapError(null);
    onSubmit({
      slug: values.slug.trim(),
      name: values.name,
      brandName: values.brandName,
      primaryColor: optional(values.primaryColor) ?? DEFAULT_PRIMARY_COLOR,
      secondaryColor: optional(values.secondaryColor) ?? DEFAULT_SECONDARY_COLOR,
      whatsapp: optional(values.whatsapp),
      email: optional(values.email),
      instagramHandle: optional(values.instagramHandle),
      website: optional(values.website),
      tone: optional(values.tone),
      fixedHashtags: values.fixedHashtags.split(/[\s,]+/).filter(Boolean),
      operatorOwned: values.operatorOwned,
      llmMonthlyCapUsd: cap,
      ...(values.brand ? { kind: "brand" as const } : {}),
    });
  };

  // Los campos que la API dijo que no sirven (`BROKER_INVALID`, sus `issues`), marcados.
  const failed = error ?? parseError;
  const invalid = new Set(
    failed instanceof ApiError ? (failed.issues ?? []).flatMap((issue) => issue.field ?? []) : [],
  );
  const input = (
    key: keyof Values,
    label: string,
    hint?: string,
    extra?: { inputMode?: "tel" },
  ) => (
    <Field label={label} htmlFor={`${id}-${key}`} hint={hint}>
      <Input
        id={`${id}-${key}`}
        name={key}
        value={String(values[key])}
        onChange={text(key)}
        aria-invalid={invalid.has(key)}
        {...extra}
      />
    </Field>
  );
  const swatch = (color: string, fallback: string) => (
    <span
      aria-hidden="true"
      className="inline-block size-3 rounded-sm border border-line align-middle"
      style={{ backgroundColor: /^#[0-9a-f]{6}$/i.test(color.trim()) ? color.trim() : fallback }}
    />
  );

  return (
    <div className="mt-3 space-y-4">
      <div className="rounded-lg border border-line p-3 text-sm">
        <label htmlFor={`${id}-template`} className="font-medium">
          Llenar desde una planilla
        </label>
        <p className="mt-1 text-fg-muted">
          Sube la planilla de Excel con la hoja Corredor llena: sus datos quedan aquí para que los
          revises. No se guarda nada hasta que apretes «Crear corredor».
        </p>
        <input
          id={`${id}-template`}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={pickTemplate}
          disabled={parsing}
          className={`mt-2 ${FILE_INPUT}`}
        />
        <div role="status">
          {parsing && <p className="mt-2 text-fg-muted">Leyendo la planilla…</p>}
          {!parsing && filled !== null && parseError === null && (
            <Alert tone="success" className="mt-2" title={`Datos de ${filled.file} listos`}>
              Revísalos y aprieta «Crear corredor».
              {filled.draft.logoFile !== null && (
                <> El logo ({filled.draft.logoFile}) se sube después, en la página del corredor.</>
              )}
              {filled.draft.warnings.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {filled.draft.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
            </Alert>
          )}
        </div>
        {parseError && <ErrorAlert error={parseError} />}
      </div>

      <form onSubmit={submit} aria-label="Crear un corredor" className="grid gap-3 sm:grid-cols-2">
        {input("name", "Nombre", "de la persona o la oficina")}
        {input("brandName", "Nombre de la marca", "como aparece en las publicaciones")}
        <div className="sm:col-span-2">
          <Field
            label={<span className="text-xs font-normal text-fg-muted">Identificador</span>}
            htmlFor={`${id}-slug`}
            hint="se arma solo desde la marca; minúsculas, números y guiones (no cambia después)"
          >
            <Input
              id={`${id}-slug`}
              name="slug"
              width="auto"
              value={values.slug}
              onChange={(event) => {
                setSlugTouched(true);
                set("slug", event.target.value);
              }}
              aria-invalid={invalid.has("slug")}
              className="px-2 py-1 text-xs"
            />
          </Field>
        </div>

        <details
          open={advanced}
          onToggle={(event) => setAdvanced(event.currentTarget.open)}
          className="rounded-lg border border-line p-3 text-sm sm:col-span-2"
        >
          <summary className="cursor-pointer font-medium">Opciones avanzadas</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {input(
              "primaryColor",
              "Color primario",
              `#RRGGBB; vacío: azul tinta ${DEFAULT_PRIMARY_COLOR}`,
            )}
            {input(
              "secondaryColor",
              "Color secundario",
              `#RRGGBB; vacío: cobre ${DEFAULT_SECONDARY_COLOR}`,
            )}
            <p className="flex items-center gap-2 text-xs text-fg-subtle sm:col-span-2">
              Así quedan: {swatch(values.primaryColor, DEFAULT_PRIMARY_COLOR)}
              {swatch(values.secondaryColor, DEFAULT_SECONDARY_COLOR)}
            </p>
            {input("whatsapp", "WhatsApp", "con código de país (Portal lo exige)", {
              inputMode: "tel",
            })}
            {input("email", "Correo")}
            {input("instagramHandle", "Instagram")}
            {input("website", "Sitio web")}
            {input("tone", "Tono de los textos")}
            {input("fixedHashtags", "Hashtags fijos", "separados por espacio")}
            <Field
              label="Tope de IA del mes (US$)"
              htmlFor={`${id}-cap`}
              hint={capError === null ? "vacío: sin tope" : undefined}
              error={capError}
            >
              <Input
                id={`${id}-cap`}
                name="cap"
                inputMode="decimal"
                value={values.cap}
                onChange={text("cap")}
              />
            </Field>
            <div className="space-y-2 self-center">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="operatorOwned"
                  checked={values.operatorOwned}
                  onChange={(event) => set("operatorOwned", event.target.checked)}
                />
                Corredor propio (usa tu plan de Claude y el formulario automático de Marketplace)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="brand"
                  checked={values.brand}
                  onChange={(event) => set("brand", event.target.checked)}
                />
                Es una marca: solo publica posts, sin propiedades (no se cambia después)
              </label>
            </div>
          </div>
        </details>

        <div className="sm:col-span-2">
          <Button type="submit" loading={pending}>
            {pending ? "Creando…" : "Crear corredor"}
          </Button>
          {error && <ErrorAlert error={error} />}
        </div>
      </form>
    </div>
  );
}
