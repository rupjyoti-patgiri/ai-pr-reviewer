import micromatch from "micromatch";
import { reviewConfig } from "../config/reviewRules";
import { logger } from "../utils/logger";
import type { PRFile } from "../github/types";
import type { SkippedFile } from "./types";

/**
 * Language detection map: file extension → language name.
 * Used for informing the AI about the programming language.
 */
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript React",
  ".js": "JavaScript",
  ".jsx": "JavaScript React",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".rb": "Ruby",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".scala": "Scala",
  ".cs": "C#",
  ".cpp": "C++",
  ".cc": "C++",
  ".c": "C",
  ".h": "C/C++ Header",
  ".hpp": "C++ Header",
  ".swift": "Swift",
  ".php": "PHP",
  ".dart": "Dart",
  ".lua": "Lua",
  ".r": "R",
  ".sql": "SQL",
  ".sh": "Shell",
  ".bash": "Bash",
  ".zsh": "Zsh",
  ".ps1": "PowerShell",
  ".yml": "YAML",
  ".yaml": "YAML",
  ".json": "JSON",
  ".xml": "XML",
  ".html": "HTML",
  ".css": "CSS",
  ".scss": "SCSS",
  ".sass": "Sass",
  ".less": "Less",
  ".md": "Markdown",
  ".mdx": "MDX",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".tf": "Terraform",
  ".hcl": "HCL",
  ".proto": "Protocol Buffers",
  ".graphql": "GraphQL",
  ".gql": "GraphQL",
  ".dockerfile": "Dockerfile",
  ".toml": "TOML",
  ".ini": "INI",
  ".cfg": "Config",
  ".env": "Environment",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".erl": "Erlang",
  ".zig": "Zig",
  ".nim": "Nim",
  ".clj": "Clojure",
  ".ml": "OCaml",
  ".hs": "Haskell",
};

/** Binary / non-reviewable file extensions */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
  ".webp", ".avif", ".tiff",
  ".mp4", ".mp3", ".wav", ".ogg", ".webm", ".avi", ".mov",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".pyc", ".class", ".o", ".obj",
]);

/**
 * Detects the programming language from a filename's extension.
 */
export function detectLanguage(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1) {
    // Handle extensionless files by name
    const basename = filename.split("/").pop() ?? filename;
    const nameMap: Record<string, string> = {
      Dockerfile: "Dockerfile",
      Makefile: "Makefile",
      Jenkinsfile: "Groovy",
      Vagrantfile: "Ruby",
      Gemfile: "Ruby",
      Rakefile: "Ruby",
      Procfile: "Procfile",
      ".gitignore": "Git Config",
      ".eslintrc": "JSON",
      ".prettierrc": "JSON",
    };
    return nameMap[basename] ?? "Unknown";
  }

  const ext = filename.slice(lastDot).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext] ?? "Unknown";
}

/**
 * Checks if a file is a binary file based on its extension.
 */
function isBinaryFile(filename: string): boolean {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1) return false;
  const ext = filename.slice(lastDot).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Filters PR files to determine which ones should be reviewed.
 *
 * Applies the following filters in order:
 * 1. Skip removed/deleted files (nothing to review)
 * 2. Skip binary files
 * 3. Skip files matching ignore patterns from config
 * 4. If include patterns are set, only keep matching files
 * 5. Skip files with no patch data (binary or too large for GitHub)
 * 6. Skip files exceeding the max changed lines threshold
 *
 * Returns both the reviewable files and the list of skipped files with reasons.
 */
export function filterFiles(
  files: PRFile[]
): { reviewable: PRFile[]; skipped: SkippedFile[] } {
  const reviewable: PRFile[] = [];
  const skipped: SkippedFile[] = [];
  const config = reviewConfig.files;

  for (const file of files) {
    // 1. Skip deleted files
    if (file.status === "removed") {
      skipped.push({
        filename: file.filename,
        reason: "File was deleted",
      });
      continue;
    }

    // 2. Skip binary files
    if (isBinaryFile(file.filename)) {
      skipped.push({
        filename: file.filename,
        reason: "Binary file",
      });
      continue;
    }

    // 3. Check ignore patterns
    if (config.ignorePatterns.length > 0) {
      const isIgnored = micromatch.isMatch(
        file.filename,
        config.ignorePatterns,
        { dot: true }
      );
      if (isIgnored) {
        skipped.push({
          filename: file.filename,
          reason: `Matches ignore pattern`,
        });
        continue;
      }
    }

    // 4. Check include patterns (if specified, ONLY review matching files)
    if (config.includePatterns.length > 0) {
      const isIncluded = micromatch.isMatch(
        file.filename,
        config.includePatterns,
        { dot: true }
      );
      if (!isIncluded) {
        skipped.push({
          filename: file.filename,
          reason: "Does not match include patterns",
        });
        continue;
      }
    }

    // 5. Skip files without patch data (GitHub omits for binary/large files)
    if (!file.patch) {
      skipped.push({
        filename: file.filename,
        reason: "No patch data available (file may be binary or too large)",
      });
      continue;
    }

    // 6. Skip files exceeding max changed lines
    if (file.changes > config.maxChangedLines) {
      skipped.push({
        filename: file.filename,
        reason: `Too many changes (${file.changes} > ${config.maxChangedLines} max)`,
      });
      continue;
    }

    // 7. Skip files exceeding max file size (estimated from patch)
    const patchLineCount = file.patch.split("\n").length;
    if (patchLineCount > config.maxFileSize) {
      skipped.push({
        filename: file.filename,
        reason: `Patch too large (${patchLineCount} lines > ${config.maxFileSize} max)`,
      });
      continue;
    }

    reviewable.push(file);
  }

  logger.info(
    {
      total: files.length,
      reviewable: reviewable.length,
      skipped: skipped.length,
    },
    "File filtering complete"
  );

  if (skipped.length > 0) {
    logger.debug(
      { skippedFiles: skipped.map((s) => `${s.filename}: ${s.reason}`) },
      "Skipped files detail"
    );
  }

  return { reviewable, skipped };
}