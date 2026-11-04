# Local neural voices

Veil Study downloads the portable Windows Piper runtime and two pinned voice models directly from their publishers into `data/reader-voices` in its application profile. The installer does not redistribute those third-party binaries or model weights. No Python, CUDA, API key, or GPU is required. Initial downloads total approximately 200 MB; unpacked runtime files use additional disk space.

- Runtime: [Piper 2023.11.14-2](https://github.com/rhasspy/piper/releases/tag/2023.11.14-2), portable Windows AMD64 release. Original Piper code is MIT; its eSpeak NG dependency is GPL, and ONNX Runtime is MIT. See the publishers' source and license notices: [Piper](https://github.com/rhasspy/piper/tree/2023.11.14-2), [eSpeak NG](https://github.com/espeak-ng/espeak-ng), [ONNX Runtime](https://github.com/microsoft/onnxruntime).
- English: [LJ Speech high](https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/ljspeech/high/MODEL_CARD), trained on the public-domain LJ Speech recordings. The model repository lists MIT licensing; its individual model card is retained beside the model.
- Swedish: [Alma medium](https://huggingface.co/rhasspy/piper-voices/blob/main/sv/sv_SE/alma/medium/MODEL_CARD), model weights CC BY 4.0. Attribution: yeagersthlm/Piper Alma, trained on the NST Swedish TTS Dataset, Språkbanken, National Library of Norway. The model card is retained beside the model.

The manifest in `src/core/neural-voice-manifest.json` pins the voice repository revision, exact URLs, sizes and SHA-256 checksums. Setup validates every runtime archive, model and configuration before use. Neural generation receives only plain text through a local process's stdin. Audio files are temporary and are removed after each request. Narration audio is played by the reader; pause, resume and sentence markers follow actual media events.

Voice quality is subjective. Use **Preview** to compare the local voices before reading a page. These voices do not provide word timestamps. **Highlight** follows the spoken sentence; it is not an exact word cursor.

The original Windows desktop voice remains available as a fallback. Dictionary assets for English and Swedish retain the licenses shipped by `dictionary-en` and `dictionary-sv` in `public/pdf-assets`.
