/**
 * Missing items of a verification (what the code shows and the card does not say): their identity across
 * verifications and how one becomes a statement of the card.
 */
import type { CardContent } from "../domain/card.ts"
import type { MissingItem } from "../domain/model.ts"

/** Same section and same text (case and spaces aside): the same item, listed again by a later verification. */
export const missingKey = (item: Pick<MissingItem, "section" | "text">): string =>
  `${item.section}:${item.text.toLowerCase().replace(/\s+/g, " ").trim()}`

/** `condition (message: "…")`, the way errors are rendered to the models (`cardStatements`). */
const ERROR_TEXT = /^(.*?)\s*\(message:\s*"(.*)"\)\s*$/s

/**
 * The card with the item appended to its section, citing the item's references. Errors and parameters are split
 * back from the text the model wrote (`condition (message: "…")`, `name: description`) when it follows that shape.
 */
export const withMissingItem = (content: CardContent, item: MissingItem): CardContent => {
  const references = item.references
  switch (item.section) {
    case "errors": {
      const match = ERROR_TEXT.exec(item.text)
      const error =
        match === null ? { condition: item.text, message: null } : { condition: match[1]!, message: match[2]! }
      return { ...content, errors: [...content.errors, { ...error, references }] }
    }
    case "parameters": {
      const colon = item.text.indexOf(":")
      const named = colon > 0 && colon <= 60
      const parameter = {
        name: named ? item.text.slice(0, colon).trim() : item.text,
        description: named ? item.text.slice(colon + 1).trim() : "",
        type: null,
        required: null,
        defaultValue: null,
        references
      }
      return { ...content, parameters: [...content.parameters, parameter] }
    }
    default:
      return { ...content, [item.section]: [...content[item.section], { text: item.text, references }] }
  }
}
