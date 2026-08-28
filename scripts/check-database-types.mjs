import ts from 'typescript'

/** Compare the actual public contract, ignoring only formatting/comments and
 * platform-specific PostgREST metadata outside the public schema. */
export function publicDatabaseContract(source) {
  const file = ts.createSourceFile('database.types.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  if (file.parseDiagnostics.length) throw new Error('Generated database types contain invalid TypeScript.')
  const database = file.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'Database')
  if (!database || !ts.isTypeLiteralNode(database.type)) throw new Error('Missing Database type.')
  const schema = database.type.members.find(node => ts.isPropertySignature(node) && node.name.getText(file).replaceAll('"', '').replaceAll("'", '') === 'public')
  if (!schema) throw new Error('Missing public database schema.')
  return ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed }).printNode(ts.EmitHint.Unspecified, schema, file)
}

export function assertDatabaseTypesMatch(checkedIn, generated) {
  if (publicDatabaseContract(checkedIn) !== publicDatabaseContract(generated)) {
    throw new Error('Database type drift: regenerate public types from the replayed migrations and review the schema difference.')
  }
}
