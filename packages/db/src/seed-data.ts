import type { brokers } from "./schema.js";

/** Corredor de demostración (F0). Las `field_definitions` se siembran en F1. */
export const DEMO_BROKER = {
  slug: "demo",
  name: "Corredor Demo",
  brandName: "Demo Propiedades",
  primaryColor: "#1F4E79",
  secondaryColor: "#F2A900",
  email: "demo@example.com",
  instagramHandle: "demo.propiedades",
  tone: "Cercano y profesional; frases cortas y datos concretos.",
  fixedHashtags: ["#propiedades", "#demo"],
  autoPublish: false,
} satisfies typeof brokers.$inferInsert;
