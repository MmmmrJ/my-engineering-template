import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readImportMetadata } from "../../src/cli/metadata.js";

describe("import metadata rights", () => {
  it.each([
    {
      basis: "licensed",
      work: "Original production music cue",
      rightsHolder: "Fixture Rights Holder",
      license: "Commercial synchronization license",
      evidence: "license-record-001",
      scope: "Worldwide episode distribution",
      verifiedAt: "2026-08-10T01:02:03.000Z",
    },
    {
      basis: "provider-terms",
      providerId: "fixture-provider",
      termsUrl: "https://provider.example.test/terms",
      termsReviewedAt: "2026-08-10T01:02:03.000Z",
      commercialUseConfirmed: true,
      thirdPartyInputsCleared: true,
    },
    {
      basis: "workflow-derived",
      sourceArtifactIds: ["artifact_source_1"],
      declaration: "Derived only from the identified cleared source.",
    },
  ])("strictly parses $basis rights", async (rights) => {
    const root = await mkdtemp(join(tmpdir(), "cartoon-metadata-"));
    const path = join(root, "metadata.json");
    await writeFile(path, JSON.stringify({ rights }), "utf8");

    await expect(readImportMetadata(path, root)).resolves.toMatchObject({ rights });
  });

  it("rejects incomplete public-domain proof and unknown union fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartoon-metadata-"));
    const incomplete = join(root, "incomplete.json");
    await writeFile(
      incomplete,
      JSON.stringify({
        rights: {
          basis: "public-domain",
          source: "1919 edition",
          evidence: "catalog-record",
          jurisdiction: "US",
        },
      }),
      "utf8",
    );
    await expect(readImportMetadata(incomplete, root)).rejects.toThrow(
      "rights.authorOrPublicationFacts",
    );

    const unknown = join(root, "unknown.json");
    await writeFile(
      unknown,
      JSON.stringify({
        rights: {
          basis: "workflow-derived",
          sourceArtifactIds: ["artifact_source_1"],
          declaration: "Cleared source only.",
          inferredApproval: true,
        },
      }),
      "utf8",
    );
    await expect(readImportMetadata(unknown, root)).rejects.toThrow("unknown field");
  });
});
