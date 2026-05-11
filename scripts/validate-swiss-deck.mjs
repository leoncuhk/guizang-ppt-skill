#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

const file = process.argv[2];
const allowExperimental = process.argv.includes('--allow-experimental');

if (!file) {
  console.error('Usage: node scripts/validate-swiss-deck.mjs <index.html> [--allow-experimental]');
  process.exit(2);
}

const html = readFileSync(file, 'utf8');
const deckDir = dirname(file);
const htmlForSlides = html.replace(/<!--[\s\S]*?-->/g, '');
const errors = [];
const warnings = [];

function getAttr(tag, name) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'))?.[1] ?? '';
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function normalizeText(text) {
  return stripTags(text)
    .toLowerCase()
    .replace(/[`"'“”‘’·.,，。:：;；!?！？/\\|()[\]{}<>《》\s_-]+/g, '')
    .trim();
}

function isLikelyDuplicate(a, b) {
  if (!a || !b || Math.min(a.length, b.length) < 6) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) >= 8 && (a.includes(b) || b.includes(a))) return true;
  return false;
}

function extractSlideLabels(slideHtml) {
  const labels = [];
  const labelRe = /<(?:h1|h2)\b[^>]*>([\s\S]*?)<\/(?:h1|h2)>|<div\b[^>]*class="[^"]*\b(?:l|r)\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  for (const match of slideHtml.matchAll(labelRe)) {
    const text = stripTags(match[1] ?? match[2] ?? '');
    if (text) labels.push(text);
  }
  return labels;
}

function parseTranslate(tag) {
  const transform = getAttr(tag, 'transform');
  const match = transform.match(/translate\(\s*(-?\d+(?:\.\d+)?)(?:[,\s]+(-?\d+(?:\.\d+)?))?/i);
  if (!match) return { x: 0, y: 0 };
  return { x: Number(match[1] ?? 0), y: Number(match[2] ?? 0) };
}

function extractSvgTexts(svg) {
  const texts = [];
  const stack = [{ x: 0, y: 0 }];
  const tokenRe = /<g\b[^>]*>|<\/g>|<text\b[^>]*>[\s\S]*?<\/text>/gi;
  for (const token of svg.matchAll(tokenRe)) {
    const raw = token[0];
    if (/^<g\b/i.test(raw)) {
      const parent = stack[stack.length - 1];
      const translate = parseTranslate(raw);
      stack.push({ x: parent.x + translate.x, y: parent.y + translate.y });
      continue;
    }
    if (/^<\/g/i.test(raw)) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const tag = raw.match(/^<text\b[^>]*>/i)?.[0] ?? '';
    const parent = stack[stack.length - 1];
    const x = Number(getAttr(tag, 'x') || 0) + parent.x;
    const y = Number(getAttr(tag, 'y') || 0) + parent.y;
    const fontSize = Number(getAttr(tag, 'font-size') || 0);
    const text = stripTags(raw);
    if (text) texts.push({ text, x, y, fontSize });
  }
  return texts;
}

function resolveLocalImage(src) {
  const clean = src.split(/[?#]/)[0];
  try {
    return join(deckDir, decodeURIComponent(clean));
  } catch {
    return join(deckDir, clean);
  }
}

const allowedLayouts = new Set([
  'SWISS-COVER-ASCII',
  'SWISS-CLOSING-ASCII',
  ...Array.from({ length: 22 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`),
]);

const slideRe = /<section\b[^>]*class="[^"]*\bslide\b[^"]*"[^>]*>[\s\S]*?<\/section>/g;
const slides = [...htmlForSlides.matchAll(slideRe)].map((m, idx) => ({ idx: idx + 1, html: m[0], tag: m[0].match(/<section\b[^>]*>/)?.[0] ?? '' }));

if (!slides.length) {
  errors.push('No <section class="slide"> pages found.');
}

slides.forEach((slide) => {
  const layout = slide.tag.match(/\bdata-layout="([^"]+)"/)?.[1];

  if (!layout) {
    errors.push(`Slide ${slide.idx}: missing data-layout. Swiss locked mode requires S01-S22 or SWISS-COVER-ASCII/SWISS-CLOSING-ASCII.`);
  } else if (!allowedLayouts.has(layout)) {
    errors.push(`Slide ${slide.idx}: data-layout="${layout}" is not registered in swiss-layout-lock.md.`);
  }

  if (!allowExperimental && /\bdata-layout="P2[34]\b|Swiss Image Split|Swiss Evidence Grid|swiss-img-split|swiss-img-grid/.test(slide.html)) {
    errors.push(`Slide ${slide.idx}: uses experimental P23/P24 image structure. Use S22 or S15/S16 image-grid adaptations instead.`);
  }

  const isStatement = layout === 'S03' || layout === 'S09' || layout === 'S10' || layout === 'SWISS-COVER-ASCII' || layout === 'SWISS-CLOSING-ASCII';
  const topChunk = slide.html.slice(0, 1800);

  if (!isStatement && /text-align\s*:\s*center/i.test(topChunk)) {
    errors.push(`Slide ${slide.idx}: top title area contains text-align:center. Swiss body titles should stay left aligned.`);
  }

  if (!isStatement && /align-self\s*:\s*center/i.test(topChunk) && /<h[12]\b/i.test(topChunk)) {
    errors.push(`Slide ${slide.idx}: top heading appears vertically/centrally aligned. Use the original left-top title skeleton.`);
  }

  if (!isStatement && /grid-template-columns\s*:\s*[0-9.]+fr\s+[0-9.]+fr/i.test(topChunk) && /<h[12]\b/i.test(topChunk)) {
    warnings.push(`Slide ${slide.idx}: heading inside a custom fr/fr grid. Confirm this is copied from the original Sxx skeleton, not a centered title hack.`);
  }

  if (/<svg\b[\s\S]*?<text\b/i.test(slide.html)) {
    errors.push(`Slide ${slide.idx}: SVG contains visible <text>. Put labels in HTML grid/captions, keep SVG for geometry only.`);
  }

  const localImages = [...slide.html.matchAll(/<img\b[^>]*src="(images\/[^"]+)"/g)];
  const slideLabels = extractSlideLabels(slide.html).map(normalizeText).filter((text) => text.length >= 6);
  localImages.forEach((match, imageIndex) => {
    const imgTag = slide.html.slice(match.index, slide.html.indexOf('>', match.index) + 1);
    if (!/\bdata-image-slot="/.test(imgTag)) {
      errors.push(`Slide ${slide.idx}: local image ${imageIndex + 1} missing data-image-slot. Bind every image to a layout slot such as s22-hero-21x9 or s15-grid-21x9.`);
    }
    const imagePath = resolveLocalImage(match[1]);
    if (!existsSync(imagePath)) {
      errors.push(`Slide ${slide.idx}: local image ${imageIndex + 1} not found: ${match[1]}.`);
      return;
    }
    if (extname(imagePath).toLowerCase() === '.svg') {
      const svg = readFileSync(imagePath, 'utf8');
      for (const svgText of extractSvgTexts(svg)) {
        const normalizedSvgText = normalizeText(svgText.text);
        if (/^\d{1,2}\s*\/\s*\d{1,2}$/.test(svgText.text)) {
          errors.push(`Slide ${slide.idx}: SVG image ${imageIndex + 1} contains a page-number-like label "${svgText.text}". Images must not include page chrome.`);
        }
        if (slideLabels.some((label) => isLikelyDuplicate(normalizedSvgText, label))) {
          errors.push(`Slide ${slide.idx}: SVG image ${imageIndex + 1} repeats a page-level title/chrome label "${svgText.text}". Put deck titles in HTML, not inside the image.`);
        }
        if (layout === 'S22' && svgText.x < 620 && svgText.y < 220 && svgText.fontSize >= 52) {
          warnings.push(`Slide ${slide.idx}: SVG image ${imageIndex + 1} has a large top-left text label "${svgText.text}". Confirm it is diagram content, not a duplicated slide title.`);
        }
      }
    }
  });

  const frameImageRe = /<div\b(?=[^>]*\bclass="([^"]*\bframe-img\b[^"]*)")[^>]*>\s*<img\b(?=[^>]*\bdata-image-slot="([^"]+)")[^>]*>/g;
  const frameImages = [...slide.html.matchAll(frameImageRe)];
  frameImages.forEach((match) => {
    const className = match[1];
    const slot = match[2];
    const frameTag = match[0].match(/^<div\b[^>]*>/)?.[0] ?? '';
    if (/^s1[56]-(?:grid|brief)-21x9$/.test(slot)) {
      if (/\bfit-contain\b/.test(className)) {
        errors.push(`Slide ${slide.idx}: ${slot} uses fit-contain. Regenerated S15/S16 21:9 images should fill the slot with .frame-img.r-21x9.`);
      }
      if (!/\br-21x9\b/.test(className)) {
        errors.push(`Slide ${slide.idx}: ${slot} must use .frame-img.r-21x9 so the image slot controls the visible size.`);
      }
      if (/height\s*:\s*\d+(?:\.\d+)?vh/i.test(frameTag)) {
        errors.push(`Slide ${slide.idx}: ${slot} frame has a fixed vh height. Use aspect-ratio .r-21x9 instead of shrinking long images into a short slot.`);
      }
    }
  });

  if (layout === 'S22') {
    if (!/data-image-slot="s22-hero-21x9"/.test(slide.html)) {
      errors.push(`Slide ${slide.idx}: S22 must use data-image-slot="s22-hero-21x9".`);
    }
    const overlayOptIn = /\bdata-s22-overlay-ok="true"/.test(slide.tag);
    if (!overlayOptIn && /class="[^"]*\bchrome-min\b[^"]*"[^>]*style="[^"]*position\s*:\s*absolute/i.test(slide.html)) {
      errors.push(`Slide ${slide.idx}: S22 places chrome-min over the image. Use an independent header bar, or opt in deliberately with data-s22-overlay-ok="true" for photo-only hero pages.`);
    }
    if (!overlayOptIn && /\bdata-anim="title-block"|\bhero-overlay-block\b/.test(slide.html)) {
      errors.push(`Slide ${slide.idx}: S22 uses an image overlay title block. Default S22 should keep titles outside the image; use data-s22-overlay-ok="true" only when the image is a photo with safe negative space.`);
    }
    if (/object-position\s*:\s*top center/i.test(slide.html)) {
      errors.push(`Slide ${slide.idx}: S22 photo uses object-position:top center, which commonly crops faces. Use center 35% or center center.`);
    }
  }
});

if (warnings.length) {
  console.warn('Warnings:');
  for (const warning of warnings) console.warn(`- ${warning}`);
}

if (errors.length) {
  console.error('Swiss deck validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Swiss deck validation passed: ${slides.length} slide(s).`);
