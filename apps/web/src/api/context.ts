import { createContext, useContext } from "react";
import { type ApiClient, createApiClient } from "./client.js";

/** El cliente de la API para todo el panel; los tests inyectan uno contra la API en proceso. */
export const ApiClientContext = createContext<ApiClient>(createApiClient());

export const useApiClient = () => useContext(ApiClientContext);
