import type { GrammarId } from "./grammars.ts"

/**
 * Tree-sitter queries, one set per grammar.
 *
 * Definitions: each pattern captures the declaration as `@definition.<kind>`
 * and its name as `@name`. When several patterns match the same node, the
 * first one wins (patterns are ordered from specific to generic), so e.g. an
 * arrow function assigned to a const is a `function`, not a `variable`.
 * Containment, top-level filtering, constructors and export rules are applied
 * in code (`extract.ts`).
 *
 * Imports: each pattern captures the import statement as `@import.<kind>` and
 * the imported module/specifier as `@source`.
 */
export interface GrammarQueries {
  readonly definitions: string
  readonly imports: string
}

const typescriptDefinitions = `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(function_signature name: (identifier) @name) @definition.function
(class_declaration name: (type_identifier) @name) @definition.class
(abstract_class_declaration name: (type_identifier) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
(method_definition name: (_) @name) @definition.method
(abstract_method_signature name: (_) @name) @definition.method
(method_signature name: (_) @name) @definition.method
(public_field_definition name: (_) @name) @definition.field
(internal_module name: (_) @name) @definition.namespace
(module name: (_) @name) @definition.module
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (generator_function)]) @definition.function
(variable_declarator name: (identifier) @name) @definition.variable
`

const javascriptDefinitions = `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (identifier) @name) @definition.class
(method_definition name: (_) @name) @definition.method
(field_definition property: (_) @name) @definition.field
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (generator_function)]) @definition.function
(variable_declarator name: (identifier) @name) @definition.variable
`

const ecmascriptImports = `
(import_statement source: (string (string_fragment) @source)) @import.import
(export_statement source: (string (string_fragment) @source)) @import.reexport
(call_expression function: (import) arguments: (arguments (string (string_fragment) @source))) @import.dynamic
((call_expression function: (identifier) @_require arguments: (arguments (string (string_fragment) @source))) @import.require
  (#eq? @_require "require"))
`

const javaDefinitions = `
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(record_declaration name: (identifier) @name) @definition.record
(annotation_type_declaration name: (identifier) @name) @definition.interface
(constructor_declaration name: (identifier) @name) @definition.constructor
(method_declaration name: (identifier) @name) @definition.method
(field_declaration declarator: (variable_declarator name: (identifier) @name)) @definition.field
`

const javaImports = `
(import_declaration [(scoped_identifier) (identifier)] @source) @import.import
`

const csharpDefinitions = `
(namespace_declaration name: (_) @name) @definition.namespace
(file_scoped_namespace_declaration name: (_) @name) @definition.namespace
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(struct_declaration name: (identifier) @name) @definition.struct
(record_declaration name: (identifier) @name) @definition.record
(constructor_declaration name: (identifier) @name) @definition.constructor
(method_declaration name: (identifier) @name) @definition.method
(property_declaration name: (identifier) @name) @definition.property
(field_declaration (variable_declaration (variable_declarator name: (identifier) @name))) @definition.field
`

const csharpImports = `
(using_directive [(qualified_name) (identifier)] @source) @import.using
`

const goDefinitions = `
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(type_spec name: (type_identifier) @name type: (struct_type)) @definition.struct
(type_spec name: (type_identifier) @name type: (interface_type)) @definition.interface
(type_spec name: (type_identifier) @name) @definition.type
(type_alias name: (type_identifier) @name) @definition.type
(const_spec name: (identifier) @name) @definition.constant
(var_spec name: (identifier) @name) @definition.variable
`

const goImports = `
(import_spec path: (interpreted_string_literal (interpreted_string_literal_content) @source)) @import.import
`

const pythonDefinitions = `
(class_definition name: (identifier) @name) @definition.class
(function_definition name: (identifier) @name) @definition.function
(module (expression_statement (assignment left: (identifier) @name) @definition.variable))
`

const pythonImports = `
(import_statement name: [(dotted_name) @source (aliased_import name: (dotted_name) @source)]) @import.import
(import_from_statement module_name: (_) @source) @import.from
`

export const grammarQueries: Readonly<Record<GrammarId, GrammarQueries>> = {
  typescript: { definitions: typescriptDefinitions, imports: ecmascriptImports },
  tsx: { definitions: typescriptDefinitions, imports: ecmascriptImports },
  javascript: { definitions: javascriptDefinitions, imports: ecmascriptImports },
  java: { definitions: javaDefinitions, imports: javaImports },
  csharp: { definitions: csharpDefinitions, imports: csharpImports },
  go: { definitions: goDefinitions, imports: goImports },
  python: { definitions: pythonDefinitions, imports: pythonImports }
}
