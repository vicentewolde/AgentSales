import { MUSIC_STYLE_TEXT, type MusicTrackId, musicTrackOf, NO_MUSIC_TEXT } from "@agentsales/core";
import { useId } from "react";
import { useMusicTracks } from "../../queries/music.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { FIELD_CONTROL, FIELD_LABEL } from "../ui/styles.js";

/**
 * «Música del reel» (F9.5-T19): elegir una pista de la biblioteca (o «Sin música», el valor por
 * defecto) y escucharla. La usan la sección Contenido de una propiedad y el detalle de un post con
 * video; quien la usa guarda el cambio (`onChange`) y dice qué pasa después (`after`).
 */
export function MusicPicker({
  label,
  value,
  onChange,
  disabled = false,
  saving = false,
  error = null,
  after,
}: {
  label: string;
  value: string | null;
  onChange: (musicTrackId: MusicTrackId | null) => void;
  disabled?: boolean;
  saving?: boolean;
  error?: Error | null;
  /** Lo que pasa al cambiarla (rehacer el reel, o que los videos se rehacen solos). */
  after: string;
}) {
  const id = useId();
  const tracks = useMusicTracks();
  const list = tracks.data ?? [];
  const selected = list.find((track) => track.id === value) ?? null;
  return (
    <fieldset
      aria-label={label}
      className="mt-4 rounded-xl border border-line bg-surface p-4 text-sm shadow-xs"
    >
      <label htmlFor={id} className={FIELD_LABEL}>
        {label}
      </label>
      <select
        id={id}
        className={`${FIELD_CONTROL} mt-1 max-w-md`}
        value={value ?? ""}
        disabled={disabled || saving || tracks.isPending}
        // Solo pistas del catálogo: la que ya no está se puede quitar, no volver a elegir.
        onChange={(event) => {
          const track = musicTrackOf(event.target.value);
          if (event.target.value === "" || track !== null) onChange(track?.id ?? null);
        }}
      >
        <option value="">{NO_MUSIC_TEXT}</option>
        {list.map((track) => (
          <option key={track.id} value={track.id}>
            {track.title} · {MUSIC_STYLE_TEXT[track.style] ?? track.style}
            {track.available ? "" : " (todavía no está subida)"}
          </option>
        ))}
        {/* Una pista que ya no está en el catálogo: se ve igual, para poder quitarla. */}
        {value !== null && !tracks.isPending && selected === null && (
          <option value={value}>{value}</option>
        )}
      </select>
      {saving && <p className="mt-2 text-fg-muted">Guardando…</p>}
      {selected?.previewUrl && (
        // biome-ignore lint/a11y/useMediaCaption: una pista instrumental, sin palabras que subtitular
        <audio
          className="mt-3 w-full max-w-md"
          controls
          preload="none"
          src={selected.previewUrl}
          aria-label={`Escuchar ${selected.title}`}
        />
      )}
      {selected !== null && !selected.available && (
        <p className="mt-2 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-warning-800">
          Esta pista todavía no está subida a la biblioteca: el video saldrá sin música hasta que el
          administrador la suba.
        </p>
      )}
      <p className="mt-2 text-xs text-fg-muted">
        Música libre de derechos (CC0): no hay que dar crédito. Si el video trae sonido, la música
        va más baja, detrás. {after}
      </p>
      {tracks.error && (
        <ErrorAlert
          error={tracks.error}
          onRetry={() => void tracks.refetch()}
          retrying={tracks.isFetching}
        />
      )}
      {error && <ErrorAlert error={error} />}
    </fieldset>
  );
}
