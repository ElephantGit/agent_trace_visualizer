/** Builds the complete React dashboard and its browser WASM runtime into one Ora archive. */
import { BlobReader, ZipWriter } from "@zip-js/zip-js";

const output = "dist/ora-space.agent-dashboard-0.2.11.orax";

async function filesUnder(directory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) files.push(...await filesUnder(path));
    else if (entry.isFile) files.push(path);
  }
  return files;
}

const files = ["orax.toml", "main.js", ...await filesUnder("assets")];
await Deno.mkdir("dist", { recursive: true });
const archive = await Deno.create(output);
const writer = new ZipWriter(archive.writable);
try {
  for (const path of files) {
    await writer.add(path, new BlobReader(new Blob([await Deno.readFile(path)])));
  }
} finally {
  await writer.close();
}
console.log(`packaged ${output}`);
