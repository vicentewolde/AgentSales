import { createContext, useContext } from "react";
import { type ApiClient, createApiClient } from "./client.js";
import { browserUploadDeps, type UploadDeps } from "./upload.js";

/** El cliente de la API para todo el panel; los tests inyectan uno contra la API en proceso. */
export const ApiClientContext = createContext<ApiClient>(createApiClient());

export const useApiClient = () => useContext(ApiClientContext);

/**
 * Cómo se sube a R2 (spec F8 §4.4): en el navegador, `XMLHttpRequest` y Web Crypto; los tests
 * inyectan un R2 en memoria.
 */
export const UploadDepsContext = createContext<UploadDeps>(browserUploadDeps);

export const useUploadDeps = () => useContext(UploadDepsContext);
