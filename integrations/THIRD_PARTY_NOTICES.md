# Third-party notices

The authoritative upstream revisions are pinned in `integrations/skills.lock.json`. This repository does not vendor or automatically install the upstream projects listed below.

## Adapted references

These sources informed original workflow documentation and skill guidance in this repository. The boundary is concepts, contracts, and production heuristics; no upstream runtime is bundled.

### MediaGo

- Source: https://github.com/mediago-dev/mediago-drama
- Pinned revision: `f06641aa3fdbf5a8845b5c477b1e58809cc16e71`
- Git tree content hash: `5b274098b7458fbc4160316e47213e61680e3195`
- License: Apache-2.0
- Boundary: stage-oriented AI drama workflow, durable artifact organization, and human checkpoint concepts were reviewed and independently adapted to this repository's nine-stage state machine.

Copyright and license notices remain with the MediaGo contributors. The Apache License 2.0 applies to the upstream work, not to provider-generated media.

### DirectorSKILL

- Source: https://github.com/wuwangzhang1216/DirectorSKILL
- Pinned revision: `47db7d9b951a9f27f7b4b727a6ca0e01ab56f7c6`
- Git tree content hash: `4e8f94deb4ee385eabc8c34d1d1b71f289ffa021`
- License: MIT
- Boundary: shot-planning, cinematic prompt, continuity, and review heuristics were reviewed and independently adapted. This template does not include director-style overlays and does not authorize imitation of protected expression or a living director's signature style.

Copyright and license notices remain with the DirectorSKILL contributors.

## Optional external integrations

The following projects are compatibility references only. They are not copied, installed, invoked, or redistributed by the core workflow. Users who install or invoke them separately must comply with their licenses, provider terms, and any media/content restrictions.

### HyperFrames

- Source: https://github.com/heygen-com/hyperframes
- Pinned revision: `c96b30c7174984e684620556ce871a285381ec60`
- Git tree content hash: `b8e65cda75e2eecfc3f4a9d329b98102bab59cf4`
- License: Apache-2.0
- Boundary: optional external deterministic HTML-to-video/rendering workflow. Its output must enter this workflow through the normal artifact/provenance and review boundary.

### ElevenLabs skills

- Source: https://github.com/elevenlabs/skills
- Pinned revision: `a3bbe2104f3c9828bfa4014149f755753842a1d0`
- Git tree content hash: `dcae2b79c9728ea0a20f2a1c4a7b43cc8ac1faa4`
- License: MIT
- Boundary: optional external audio skill guidance. It is not a bundled voice provider, and it does not change this repository's prohibition on voice cloning or real-person voice imitation.

## Generated content and service terms

Open-source licenses for these repositories do not grant rights to prompts, models, voices, characters, music, generated results, trademarks, or third-party inputs. Provider and model terms remain separate and must be recorded in each task's provenance review.
