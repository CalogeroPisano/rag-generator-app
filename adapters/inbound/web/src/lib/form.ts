/** Text value of a form field; files and missing fields read as "". */
export const formText = (form: FormData, name: string): string => {
  const value = form.get(name)
  return typeof value === "string" ? value : ""
}
