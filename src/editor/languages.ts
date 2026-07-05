import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";

/** Resolve a CodeMirror language extension for the given file name/path, if any. */
export async function languageExtensionFor(fileName: string): Promise<Extension[]> {
  const desc = LanguageDescription.matchFilename(languages, fileName);
  if (!desc) return [];
  try {
    const support = await desc.load();
    return [support];
  } catch {
    return [];
  }
}
