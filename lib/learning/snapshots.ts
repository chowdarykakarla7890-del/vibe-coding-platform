export const MAX_SOURCE_FILE_BYTES = 256 * 1024
export const MAX_PROJECT_FILES = 200
export const MAX_PROJECT_SNAPSHOT_BYTES = 10 * 1024 * 1024

export const EXCLUDED_SEGMENTS = new Set([
  // The VM image shares its workspace with tool-home files. These are runtime
  // credentials, histories and caches, not portable project source.
  '.codex', '.claude', '.local', '.npm', '.pnpm-store', '.bun', '.cargo', '.rustup', '.m2', '.gradle',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.yarn',
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.netrc', '.pypirc', '.git-credentials', '.gitconfig',
  '.bash_history', '.zsh_history', '.python_history', '.node_repl_history', '.sudo_as_admin_successful',
  '.bashrc', '.bash_profile', '.profile', '.zshrc', '.zprofile', '.wget-hsts', '.lesshst', '.viminfo',
  'id_rsa', 'id_ed25519', 'id_ecdsa', '.env',
  '.aws',
  '.cache',
  '.config',
  '.git',
  '.gnupg',
  '.next',
  '.ssh',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
])

export const BINARY_EXTENSIONS = new Set([
  '7z', 'avi', 'bin', 'bmp', 'class', 'db', 'dll', 'dmg', 'doc', 'docx',
  'eot', 'exe', 'gif', 'gz', 'ico', 'jar', 'jpeg', 'jpg', 'lockb', 'mov',
  'mp3', 'mp4', 'o', 'otf', 'pdf', 'png', 'so', 'sqlite', 'tar', 'ttf',
  'p12', 'pem', 'pfx', 'key', 'wav', 'webm', 'webp', 'woff', 'woff2',
  'xls', 'xlsx', 'zip',
])

const encoder = new TextEncoder()

export function sourceByteLength(content: string) {
  return encoder.encode(content).byteLength
}

/** A file cannot also be the directory containing another saved file. */
export function hasSnapshotPathConflict(paths: Iterable<string>) {
  const names = new Set(paths)
  for (const path of names) {
    for (let index = path.indexOf('/'); index !== -1; index = path.indexOf('/', index + 1)) {
      if (names.has(path.slice(0, index))) return true
    }
  }
  return false
}

export function isSafeSnapshotPath(path: string) {
  if (
    !path ||
    path.length > 240 ||
    path.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    return false
  }
  if (path.startsWith('/') || path.endsWith('/') || path.includes('//')) return false

  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.codetutor-') || EXCLUDED_SEGMENTS.has(segment))) {
    return false
  }

  const fileName = segments.at(-1) ?? ''
  if (
    fileName === '.env' ||
    (fileName.startsWith('.env.') && fileName !== '.env.example')
  ) {
    return false
  }
  const extension = fileName.includes('.') ? fileName.split('.').at(-1)?.toLowerCase() : undefined
  return !extension || !BINARY_EXTENSIONS.has(extension)
}

export function isValidSnapshotFile(file: { path: string; content: string }) {
  return isSafeSnapshotPath(file.path) && sourceByteLength(file.content) <= MAX_SOURCE_FILE_BYTES
}
