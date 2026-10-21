import {z, type ZodType} from "zod";

type JsonSchema = Record<string, unknown>;

/** Keywords strict mode rejects or ignores. They are dropped: zod validates the answer again anyway. */
const UNSUPPORTED = [
    "$schema",
    "default",
    "examples",
    "propertyNames",
    "patternProperties",
    "unevaluatedProperties",
    "minProperties",
    "maxProperties",
    "minLength",
    "maxLength",
    "uniqueItems",
    "contains"
];

export interface StrictSchema {
    schema: JsonSchema;
    /** Per object node: the properties that were optional and became nullable. */
    optionalKeys: WeakMap<object, Set<string>>;
}

const isObject = (value: unknown): value is JsonSchema =>
    typeof value === "object" && value !== null && !Array.isArray(value);

function allowsNull(node: JsonSchema): boolean {
    if (node.type === "null" || (Array.isArray(node.type) && node.type.includes("null"))) return true;
    const union = node.anyOf ?? node.oneOf;
    return Array.isArray(union) && union.some((branch) => isObject(branch) && allowsNull(branch));
}

/**
 * JSON Schema of a zod schema, made compatible with OpenAI structured outputs in strict mode: every object
 * lists all its properties in `required` and has `additionalProperties: false`; optional properties become
 * nullable (and the nulls are removed again by `stripOptionalNulls` before validation). Records lose their
 * free-form keys: strict mode cannot express them.
 */
export function toStrictJsonSchema(schema: ZodType): StrictSchema {
    const optionalKeys = new WeakMap<object, Set<string>>();
    const root = z.toJSONSchema(schema, {io: "input", unrepresentable: "any"}) as JsonSchema;

    const visit = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(visit);
        if (!isObject(node)) return;
        for (const keyword of UNSUPPORTED) delete node[keyword];
        if (Array.isArray(node.oneOf)) {
            node.anyOf = node.oneOf;
            delete node.oneOf;
        }
        for (const key of ["items", "prefixItems", "anyOf", "allOf", "not"]) visit(node[key]);
        for (const key of ["$defs", "definitions"]) {
            if (isObject(node[key])) Object.values(node[key]).forEach(visit);
        }
        const isObjectNode = node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"));
        if (!isObjectNode && !isObject(node.properties)) return;

        const properties = isObject(node.properties) ? node.properties : {};
        const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
        const optional = new Set<string>();
        for (const [key, child] of Object.entries(properties)) {
            visit(child);
            if (required.has(key) || !isObject(child) || allowsNull(child)) continue;
            properties[key] = {anyOf: [child, {type: "null"}]};
            optional.add(key);
        }
        node.properties = properties;
        node.required = Object.keys(properties);
        node.additionalProperties = false;
        if (optional.size > 0) optionalKeys.set(node, optional);
    };
    visit(root);
    return {schema: root, optionalKeys};
}

function resolveRef(node: JsonSchema, root: JsonSchema): JsonSchema {
    let current = node;
    for (let depth = 0; typeof current.$ref === "string" && depth < 32; depth++) {
        const ref = current.$ref as string;
        if (ref === "#") {
            current = root;
            continue;
        }
        const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
        const defs = match ? root[match[1] as string] : undefined;
        const target = isObject(defs) ? defs[decodeURIComponent(match?.[2] ?? "")] : undefined;
        if (!isObject(target)) return current;
        current = target;
    }
    return current;
}

function matches(value: unknown, branch: JsonSchema): boolean {
    const types = Array.isArray(branch.type) ? branch.type : [branch.type];
    if (value === null) return types.includes("null");
    if (Array.isArray(value)) return types.includes("array") || branch.items !== undefined;
    if (isObject(value)) {
        if (!types.includes("object") && !isObject(branch.properties)) return false;
        const properties = isObject(branch.properties) ? branch.properties : {};
        return Object.keys(value).every((key) => key in properties);
    }
    return true;
}

/** Removes the nulls the model put in properties that were optional in the zod schema. */
export function stripOptionalNulls(value: unknown, strict: StrictSchema): unknown {
    const walk = (current: unknown, schemaNode: unknown): unknown => {
        if (!isObject(schemaNode)) return current;
        const node = resolveRef(schemaNode, strict.schema);
        if (Array.isArray(node.anyOf)) {
            const branch = node.anyOf.find(
                (candidate) => isObject(candidate) && matches(current, resolveRef(candidate, strict.schema))
            );
            return branch === undefined ? current : walk(current, branch);
        }
        if (Array.isArray(current)) return current.map((item) => walk(item, node.items));
        if (!isObject(current) || !isObject(node.properties)) return current;
        const optional = strict.optionalKeys.get(node);
        const result: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(current)) {
            if (child === null && optional?.has(key)) continue;
            result[key] = walk(child, node.properties[key]);
        }
        return result;
    };
    return walk(value, strict.schema);
}
