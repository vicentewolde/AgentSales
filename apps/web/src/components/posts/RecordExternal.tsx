import type { ContentView } from "@agentsales/api/contracts";
import {
  chileInputValue,
  isAppError,
  LANGUAGE_TEXT,
  PLATFORM_TEXT,
  type PostPlatform,
  parseChileTime,
} from "@agentsales/core";
import { useId, useState } from "react";
import { useRecordPost } from "../../queries/posts.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Button } from "../ui/Button.js";
import { Field, Input, Select } from "../ui/Field.js";
import { postContents } from "./labels.js";

/** El enlace de ejemplo de cada red, para que se vea qué pegar. */
const EXAMPLES: Readonly<Partial<Record<PostPlatform, string>>> = {
  x: "https://x.com/agentpeyai/status/1234567890123456789",
  linkedin: "https://www.linkedin.com/feed/update/urn:li:share:1234567890123456789/",
  instagram: "https://www.instagram.com/p/AbCdEfGhIjK/",
  discord: "https://discord.com/channels/111/222/333",
  tiktok: "https://www.tiktok.com/@cuenta/video/1234567890123456789",
};

/**
 * «Ya lo publiqué fuera de AgentSales»: para un texto del post que ya está en la red (lo publicaste
 * a mano, o antes), lo registra con su enlace para seguirlo en Seguimiento. No publica nada. Si ese
 * texto tenía una publicación simulada, queda como retirada (no se borra).
 */
export function RecordExternal({
  postId,
  contents,
  lockReason,
}: {
  postId: string;
  contents: readonly ContentView[];
  lockReason: string | null;
}) {
  const options = postContents(contents);
  const record = useRecordPost(postId);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState("");
  const [url, setUrl] = useState("");
  const [when, setWhen] = useState(chileInputValue(new Date()));
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (options.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        Cuando el post tenga un texto, aquí podrás registrar que ya lo publicaste en la red.
      </p>
    );
  }
  const selected =
    options.find((item) => `${item.platform}/${item.language}` === choice) ?? options[0];
  if (selected === undefined) return null;
  const example = EXAMPLES[selected.platform] ?? "https://…";

  const submit = () => {
    let publishedAt: string;
    try {
      publishedAt = parseChileTime(when).toISOString();
    } catch (error) {
      setProblem(isAppError(error) ? error.message : "La fecha no se entiende");
      return;
    }
    if (url.trim() === "") {
      setProblem("Pega el enlace del post en la red");
      return;
    }
    setProblem(null);
    record.mutate(
      { platform: selected.platform, language: selected.language, url: url.trim(), publishedAt },
      {
        onSuccess: () => {
          setDone(true);
          setOpen(false);
          setUrl("");
        },
      },
    );
  };

  return (
    <div className="space-y-3 text-sm">
      <p className="text-fg-muted">
        ¿Ya lo publicaste en la red por tu cuenta, o antes de usar AgentSales? Regístralo con su
        enlace y lo sigues desde Seguimiento. Esto no publica nada.
      </p>
      {done && (
        <p role="status" className="font-medium text-success-800">
          Listo: quedó registrado como publicado. Lo ves en Publicaciones y en Seguimiento.
        </p>
      )}
      {!open ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={lockReason !== null}
          onClick={() => {
            setOpen(true);
            setDone(false);
            setWhen(chileInputValue(new Date()));
          }}
        >
          Ya lo publiqué fuera de AgentSales
        </Button>
      ) : (
        <form
          className="space-y-3 rounded-lg border border-line bg-canvas p-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {options.length > 1 && (
            <Field label="¿Cuál texto?" htmlFor={`${id}-texto`}>
              <Select
                id={`${id}-texto`}
                value={`${selected.platform}/${selected.language}`}
                onChange={(event) => setChoice(event.target.value)}
              >
                {options.map((item) => (
                  <option
                    key={`${item.platform}/${item.language}`}
                    value={`${item.platform}/${item.language}`}
                  >
                    {PLATFORM_TEXT[item.platform]} · {LANGUAGE_TEXT[item.language]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field
            label={`Enlace del post en ${PLATFORM_TEXT[selected.platform]}`}
            htmlFor={`${id}-enlace`}
            hint={`Ejemplo: ${example}`}
          >
            <Input
              id={`${id}-enlace`}
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder={example}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </Field>
          <Field
            label="Cuándo lo publicaste (hora de Chile)"
            htmlFor={`${id}-fecha`}
            hint="Si no te acuerdas, déjala como está: se anota ahora."
          >
            <Input
              id={`${id}-fecha`}
              type="datetime-local"
              width="auto"
              className="w-fit max-w-full"
              value={when}
              onChange={(event) => setWhen(event.target.value)}
            />
          </Field>
          {problem !== null && (
            <p role="alert" className="font-medium text-danger-700">
              {problem}
            </p>
          )}
          {record.error && <ErrorAlert error={record.error} />}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={record.isPending}>
              Registrar como publicado
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
