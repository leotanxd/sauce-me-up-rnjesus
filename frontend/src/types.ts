export type Sauce = {
  id: number
  title: string
  /** Public source page, e.g. https://nhentai.net/g/{id}/ */
  url: string
  /** ONLY the first page/cover image — the backend never sends the rest */
  firstImageUrl: string | null
}
