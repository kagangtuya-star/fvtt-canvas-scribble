/** Release metadata is derived from the tag, never written back to source manifests. */
const NUMERIC = "(?:0|[1-9]\\d*)";
const PRERELEASE = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
export const VERSION_RE = new RegExp(
  `^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE}(?:\\.${PRERELEASE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

export function configureManifest(source, { repo, tag } = {}) {
  const manifest = { ...source };
  const version = tag === undefined ? manifest.version : typeof tag === "string" ? tag.replace(/^v/, "") : undefined;
  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    throw new Error(
      tag === undefined
        ? `Invalid module version ${JSON.stringify(version)} (expected X.Y.Z)`
        : `Invalid release tag ${JSON.stringify(tag)} (expected vX.Y.Z or X.Y.Z)`,
    );
  }
  manifest.version = version;
  if (repo !== undefined) {
    if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error(`Invalid repository ${JSON.stringify(repo)} (expected owner/name)`);
    }
    const url = `https://github.com/${repo}`;
    manifest.url = url;
    manifest.manifest = `${url}/releases/latest/download/module.json`;
    manifest.download = `${url}/releases/download/${encodeURIComponent(tag ?? `v${version}`)}/module.zip`;
    manifest.bugs = `${url}/issues`;
  }
  return manifest;
}
