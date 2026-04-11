import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { CassandraSchemaBundleSchema } from "../src/schemas.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(currentDir, "../dist/schemas.json");

const packageSchema = zodToJsonSchema(CassandraSchemaBundleSchema, {
  name: "CassandraSchemaBundle",
  target: "jsonSchema7",
});

const packageDefinition =
  "definitions" in packageSchema &&
  packageSchema.definitions &&
  typeof packageSchema.definitions === "object"
    ? packageSchema.definitions.CassandraSchemaBundle
    : undefined;

const hasUsefulPackageDefinition =
  packageDefinition &&
  typeof packageDefinition === "object" &&
  Object.keys(packageDefinition).length > 0;

const jsonSchema = hasUsefulPackageDefinition
  ? packageSchema
  : {
      $id: "CassandraSchemaBundle",
      title: "CassandraSchemaBundle",
      ...z.toJSONSchema(CassandraSchemaBundleSchema),
    };

await mkdir(dirname(outputPath), {
  recursive: true,
});

await writeFile(outputPath, `${JSON.stringify(jsonSchema, null, 2)}\n`, "utf8");
