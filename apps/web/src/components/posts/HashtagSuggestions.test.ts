import { describe, expect, it } from "vitest";
import { suggestHashtags } from "./HashtagSuggestions.js";

describe("suggestHashtags: hashtags sugeridos sin IA", () => {
  const body =
    "Thank you @StellarOrg for supporting what we're building at AgentPey: AI agents that buy online and pay in USDC on Stellar. The SDK is on npm: @agentpey/ucp-stellar";

  it("primero los del perfil, después nombres propios y siglas del texto, en minúsculas como se guardan", () => {
    expect(suggestHashtags(body, ["#Stellar", "agentesdeia"], [])).toEqual([
      "#stellar",
      "#agentesdeia",
      "#agentpey",
      "#ai",
      "#usdc",
      "#sdk",
    ]);
  });

  it("no repite los que ya tiene (sin importar mayúsculas) ni toma menciones, enlaces o palabras comunes", () => {
    const out = suggestHashtags(body, [], ["#usdc", "#agentpey"]);
    expect(out).not.toContain("#usdc");
    expect(out).not.toContain("#agentpey");
    expect(out).not.toContain("#stellarorg");
    expect(out).not.toContain("#thank");
    expect(out).not.toContain("#the");
  });

  it("en español, igual", () => {
    expect(
      suggestHashtags("Gracias a Stellar. Con AgentPey, Claude y ChatGPT pagan en USDC.", [], []),
    ).toEqual(["#stellar", "#agentpey", "#claude", "#chatgpt", "#usdc"]);
  });

  it("como mucho `max`", () => {
    expect(suggestHashtags(body, ["#a1", "#b2", "#c3"], [], 2)).toHaveLength(2);
  });
});
