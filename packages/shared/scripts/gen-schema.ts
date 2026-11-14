// Generates docs/contracts/ingest.schema.json from the zod ingest contract.
// The Java plugin's tests validate its payloads against this file.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  helloRequest,
  metricsRequest,
  eventsRequest,
  snapshotRequest,
  ingestAccepted,
  ingestRejected,
  INGEST_SCHEMA_VERSION,
} from "../src/contracts/ingest";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../docs/contracts/ingest.schema.json");

const defs = {
  helloRequest,
  metricsRequest,
  eventsRequest,
  snapshotRequest,
  ingestAccepted,
  ingestRejected,
};

const schemas = Object.fromEntries(
  Object.entries(defs).map(([name, schema]) => [
    name,
    zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "none" }),
  ]),
);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    { $comment: `Generated from packages/shared/src/contracts/ingest.ts — do not edit. schemaVersion ${INGEST_SCHEMA_VERSION}`, schemas },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${out}`);
