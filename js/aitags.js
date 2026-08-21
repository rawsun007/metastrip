/* MetaStrip — generator metadata from AI image tools.

   An image out of Stable Diffusion carries the entire recipe in a PNG text
   chunk: the prompt, the negative prompt, the seed, the sampler, the model
   and its hash. ComfyUI goes further and embeds the whole node graph.

   That matters for two opposite reasons. Posting the file hands over your
   prompt, which people treat as work product, and it also proves how the
   image was made — which some people want kept and others very much do not.
   Either way it should not be a surprise, so these chunks get named for what
   they are instead of being listed as "PNG parameters".

   Nothing here changes how removal works: they are ordinary text chunks and
   were always removable. What changes is that you can see what you are
   removing. */

const AI_TEXT_KEYS = {
  parameters: "Automatic1111 or Forge",
  prompt: "ComfyUI",
  workflow: "ComfyUI",
  "sd-metadata": "InvokeAI",
  invokeai_metadata: "InvokeAI",
  invokeai_graph: "InvokeAI",
  dream: "InvokeAI",
  Dream: "InvokeAI",
  "Comment": "NovelAI",
  Description: "NovelAI",
  aesthetic_score: "Fooocus",
  fooocus_scheme: "Fooocus",
  Software: null, // only meaningful when it names a known tool
};

const AI_SOFTWARE_NAMES = /(novelai|stable diffusion|comfyui|automatic1111|invokeai|fooocus|midjourney|dall-?e|sdxl|flux)/i;

/** Describes an AI generator tag, or returns null when it is not one. */
function describeAiTag(keyword, value) {
  if (!value) return null;
  const key = String(keyword);
  const tool = resolveTool(key, value);
  if (!tool) return null;

  const fields = [];
  const details = key === "workflow" || looksLikeJson(value) ? readJsonRecipe(value) : readPlainRecipe(value);

  fields.push({
    label: `AI prompt (${tool})`,
    value: details.prompt || `${tool} generation data, ${(value.length / 1024).toFixed(1)} KB`,
    risk: "identity",
  });
  if (details.negative) {
    fields.push({ label: "AI negative prompt", value: details.negative, risk: "identity" });
  }
  const settings = [
    details.model ? `model ${details.model}` : null,
    details.seed ? `seed ${details.seed}` : null,
    details.steps ? `${details.steps} steps` : null,
    details.sampler ? `sampler ${details.sampler}` : null,
  ].filter(Boolean);
  if (settings.length) {
    fields.push({ label: "AI settings", value: settings.join(", "), risk: "device" });
  }
  return fields;
}

function resolveTool(key, value) {
  if (key === "Software" || key === "software") {
    const match = AI_SOFTWARE_NAMES.exec(value);
    return match ? titleCaseTool(match[1]) : null;
  }
  const known = AI_TEXT_KEYS[key];
  if (known) {
    // "prompt" and "Comment" are common words; require corroboration
    if ((key === "prompt" || key === "Comment") && !looksLikeJson(value)) return null;
    return known;
  }
  const match = AI_SOFTWARE_NAMES.exec(value.slice(0, 400));
  return match ? titleCaseTool(match[1]) : null;
}

function titleCaseTool(name) {
  const map = {
    novelai: "NovelAI",
    comfyui: "ComfyUI",
    automatic1111: "Automatic1111",
    invokeai: "InvokeAI",
    fooocus: "Fooocus",
    midjourney: "Midjourney",
    sdxl: "Stable Diffusion",
    flux: "Flux",
  };
  const key = name.toLowerCase().replace("dalle", "dall-e");
  return map[key] || key.replace(/\b\w/g, (c) => c.toUpperCase());
}

function looksLikeJson(value) {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

/* The Automatic1111 format: the prompt, then a "Negative prompt:" line, then
   a comma-separated settings line. */
function readPlainRecipe(value) {
  const negativeAt = value.indexOf("Negative prompt:");
  const settingsMatch = /(^|\n)(Steps:\s*\d+.*)$/m.exec(value);
  const settingsAt = settingsMatch ? settingsMatch.index : -1;

  const promptEnd = negativeAt >= 0 ? negativeAt : settingsAt >= 0 ? settingsAt : value.length;
  const prompt = clip(value.slice(0, promptEnd));
  const negative =
    negativeAt >= 0
      ? clip(value.slice(negativeAt + "Negative prompt:".length, settingsAt >= 0 ? settingsAt : value.length))
      : null;

  const settings = settingsAt >= 0 ? value.slice(settingsAt) : value;
  return {
    prompt,
    negative,
    seed: firstMatch(settings, /Seed:\s*(\d+)/),
    steps: firstMatch(settings, /Steps:\s*(\d+)/),
    sampler: firstMatch(settings, /Sampler:\s*([^,\n]+)/),
    model: firstMatch(settings, /Model:\s*([^,\n]+)/) || firstMatch(settings, /Model hash:\s*([^,\n]+)/),
  };
}

/* ComfyUI and InvokeAI embed JSON. The prompt is whatever text a node was
   given, and the model is whichever checkpoint it loaded. */
function readJsonRecipe(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return readPlainRecipe(value);
  }
  const texts = [];
  const models = [];
  let seed = null;
  let steps = null;

  const visit = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 8) return;
    for (const [key, entry] of Object.entries(node)) {
      if (typeof entry === "string") {
        if (/^(text|prompt|positive)$/i.test(key) && entry.length > 1) texts.push(entry);
        if (/ckpt_name|model_name|model$/i.test(key)) models.push(entry);
      } else if (typeof entry === "number") {
        if (/^(seed|noise_seed)$/i.test(key) && !seed) seed = String(entry);
        if (/^steps$/i.test(key) && !steps) steps = String(entry);
      } else {
        visit(entry, depth + 1);
      }
    }
  };
  visit(parsed, 0);

  return {
    prompt: texts.length ? clip(texts[0]) : null,
    negative: texts.length > 1 ? clip(texts[1]) : null,
    seed,
    steps,
    sampler: null,
    model: models.length ? clip(models[0], 60) : null,
  };
}

function firstMatch(text, pattern) {
  const match = pattern.exec(text);
  return match ? match[1].trim() : null;
}

function clip(text, limit = 180) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}
