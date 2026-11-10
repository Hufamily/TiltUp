// Prints the CHANGELOG.md notes for one version (used as GitHub release notes).
// Usage: node tools/changelog.mjs <version>
import { readText } from './lib/project.mjs';

const v = process.argv[2] || '';
const sections = readText('CHANGELOG.md').split(/^## /m).slice(1);
const hit = sections.find((s) => s.split(/\s/)[0] === v);
console.log(hit ? hit.slice(hit.indexOf('\n') + 1).trim() : `Tilt Up ${v}`);
