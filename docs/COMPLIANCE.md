# Compliance

This template uses a fail-closed production policy. It is operational guidance, not legal advice; the responsible human must obtain legal review where the release risk warrants it.

## IP admission

Accept only:

- an original IP created and controlled by the user; or
- an IP proven public domain in the jurisdiction and for the intended use.

For public-domain material, retain the authoritative source/catalog URL, author or publication facts, jurisdiction, legal basis, and verification date. Age, folklore status, online availability, or an unverified user statement is not enough.

Reject copyrighted franchises, characters, scripts, illustrations, music, recognizable substitutes, and unauthorized trademark use. Do not request or produce the signature style of a living artist or director; describe transferable attributes such as composition, lighting, palette, lens, texture, and pacing.

## Likeness and voice

Voice cloning is disabled by default. Do not synthesize or imitate a real person's voice, face, identity, or endorsement without separate, specific consent evidence for the intended use. V1 must never activate cloning implicitly; an imported clone must be an `audio` artifact explicitly marked `metadata.voiceClone=true` and record subject, scope, authorization evidence/time, and a later user-confirmation statement/time (plus review event ID when available). Prefer synthetic catalog voices or original recordings whose distribution rights are documented.

## Provenance record

For each user-supplied, generated, stock, or public-domain asset, retain as applicable:

- origin, creator/provider, creation/import date, and source path/URL;
- license, provider-terms basis, attribution, and intended-use restrictions;
- provider, model/tool, request/resource ID, prompts and relevant settings;
- checksum and modifications;
- real-person, trademark, personal-data, and third-party-input review.

ComfyUI workflow availability does not prove checkpoint or LoRA rights. Record model-file provenance separately.

## Release checklist

- IP admission evidence is complete.
- Fonts, music, SFX, voices, images, and clips permit the intended distribution.
- No unapproved logo, watermark, personal data, real-person likeness, or imitation remains.
- Provider commercial-use, attribution, retention, geography, and prohibited-content terms were reviewed.
- Required AI-generated-media disclosures, labels, or platform declarations are ready.
- The final video carries a visible AI-generated label, embedded metadata, and a provenance manifest. The release reviewer must check the current requirements in the [Measures for Labeling AI-Generated Synthetic Content](https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm) and [GB 45438-2025](https://std.samr.gov.cn/gb/search/gbDetailed?id=301E0388CB75788DE06397BE0A0AE1B4).
- The final video and SRT match the approved content and QC evidence.

Stop export when a blocking item is unknown. Record any non-blocking waiver with the responsible human's decision.
