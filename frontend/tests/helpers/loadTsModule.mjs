import { readFile } from 'node:fs/promises'
import ts from 'typescript'

export async function loadTsModule(sourcePath, stubs = {}) {
  const source = await readFile(sourcePath, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const loadedModule = { exports: {} }
  const localRequire = (specifier) => {
    if (Object.hasOwn(stubs, specifier)) return stubs[specifier]
    throw new Error(`Unexpected import: ${specifier}`)
  }
  new Function('require', 'module', 'exports', compiled)(localRequire, loadedModule, loadedModule.exports)
  return loadedModule.exports
}
