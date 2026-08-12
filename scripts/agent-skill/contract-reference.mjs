import ts from 'typescript'

const exported = (node) => node.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)

const findVariableInitializer = (sourceFile, name) => {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration.initializer
      }
    }
  }
  throw new Error(`Agora contract source is missing ${name}.`)
}

const findTypeAlias = (sourceFile, name) => {
  const alias = sourceFile.statements.find((statement) => (
    ts.isTypeAliasDeclaration(statement) && statement.name.text === name
  ))
  if (!alias) throw new Error(`Agora contract source is missing ${name}.`)
  return alias
}

const renderType = (node, sourceFile, privateAliases) => {
  if (ts.isTypeReferenceNode(node)
    && ts.isIdentifier(node.typeName)
    && privateAliases.has(node.typeName.text)) {
    return renderType(privateAliases.get(node.typeName.text).type, sourceFile, privateAliases)
  }
  if (ts.isTypeLiteralNode(node)) {
    const members = node.members
      .filter((member) => ts.isPropertySignature(member))
      .map((member) => {
        const name = member.name.getText(sourceFile)
        const type = member.type ? renderType(member.type, sourceFile, privateAliases) : 'unknown'
        return `  ${name}${member.questionToken ? '?' : ''}: ${type}`
      })
    return members.length === 0 ? '{}' : `{\n${members.join('\n')}\n}`
  }
  if (ts.isIntersectionTypeNode(node)) {
    return node.types.map((type) => renderType(type, sourceFile, privateAliases)).join(' & ')
  }
  if (ts.isUnionTypeNode(node)) {
    return node.types.map((type) => renderType(type, sourceFile, privateAliases)).join(' | ')
  }
  if (ts.isParenthesizedTypeNode(node)) {
    return `(${renderType(node.type, sourceFile, privateAliases)})`
  }
  if (ts.isArrayTypeNode(node)) {
    return `${renderType(node.elementType, sourceFile, privateAliases)}[]`
  }
  if (ts.isTypeReferenceNode(node) && node.typeArguments?.length) {
    return `${node.typeName.getText(sourceFile)}<${node.typeArguments
      .map((type) => renderType(type, sourceFile, privateAliases)).join(', ')}>`
  }
  return node.getText(sourceFile)
}

const renderDtos = (sourceFile) => {
  const aliases = sourceFile.statements.filter(ts.isTypeAliasDeclaration)
  const privateAliases = new Map(aliases.filter((alias) => !exported(alias)).map((alias) => [
    alias.name.text,
    alias
  ]))

  return aliases.filter(exported).map((alias) => {
    const parameters = alias.typeParameters?.length
      ? `<${alias.typeParameters.map((parameter) => parameter.getText(sourceFile)).join(', ')}>`
      : ''
    return `### ${alias.name.text}\n\n\`\`\`ts\ntype ${alias.name.text}${parameters} = ${renderType(alias.type, sourceFile, privateAliases)}\n\`\`\``
  }).join('\n\n')
}

export const generateApiReference = ({ contractPath, dtoPath, identifiersPath }) => {
  const program = ts.createProgram(
    [contractPath, dtoPath, identifiersPath],
    {
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022
    }
  )
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: process.cwd,
      getNewLine: () => '\n'
    }))
  }

  const bySuffix = (suffix) => {
    const source = program.getSourceFiles().find(({ fileName }) => fileName.endsWith(suffix))
    if (!source) throw new Error(`Agora contract source is missing ${suffix}.`)
    return source
  }
  const identifiersSource = bySuffix('agoraRequestIdentifiers.ts')
  const contractSource = bySuffix('agoraRequestContract.ts')
  const dtoSource = bySuffix('agoraDtos.ts')
  const versionNode = findVariableInitializer(identifiersSource, 'agoraContractVersion')
  const version = ts.isAsExpression(versionNode) ? versionNode.expression.getText(identifiersSource) : versionNode.getText(identifiersSource)
  const identifierNode = findVariableInitializer(identifiersSource, 'agoraRequestIdentifiers')
  const identifierObject = ts.isAsExpression(identifierNode) ? identifierNode.expression : identifierNode
  if (!ts.isObjectLiteralExpression(identifierObject)) {
    throw new Error('Agora request identifiers must use an object literal.')
  }
  const identifiers = identifierObject.properties.map((property) => {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer)) {
      throw new Error('Agora request identifiers must use string property assignments.')
    }
    return property.initializer.text
  })
  const catalog = findTypeAlias(contractSource, 'AgoraRequestCatalog')
  if (!ts.isTypeLiteralNode(catalog.type)) throw new Error('Agora request catalog must be a type literal.')
  const operations = catalog.type.members.map((member) => {
    if (!ts.isPropertySignature(member) || !member.type || !ts.isTypeLiteralNode(member.type)) {
      throw new Error('Agora request catalog entries must be type literals.')
    }
    const name = member.name.getText(contractSource)
    const fields = new Map(member.type.members.map((field) => [
      field.name?.getText(contractSource),
      field.type
    ]))
    if (!fields.get('params') || !fields.get('result')) {
      throw new Error(`Agora request catalog entry ${name} is incomplete.`)
    }
    return {
      name,
      params: fields.get('params').getText(contractSource),
      result: fields.get('result').getText(contractSource)
    }
  })
  if (identifiers.join('\n') !== operations.map(({ name }) => name).join('\n')) {
    throw new Error('Agora identifier and request catalog order or membership has drifted.')
  }

  const operationReference = operations.map(({ name, params, result }) => (
    `### \`${name}\`\n\n- Parameters: \`${params}\`\n- Result: \`${result}\``
  )).join('\n\n')

  return `# Agora API reference\n\nThis file is generated from the shared dispatcher request/response contract.\nDo not edit it directly.\n\n- Contract version: \`${version}\`\n- Canonical request route: \`POST /functions/v1/agora\`\n- Envelope: \`{ identifier, params, version }\` with exact keys\n\n## Supported request identifiers\n\n${identifiers.map((identifier) => `- \`${identifier}\``).join('\n')}\n\n## Request catalog\n\n${operationReference}\n\n## DTO and parameter types\n\n${renderDtos(dtoSource)}\n`
}
