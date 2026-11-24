export type Sauce = {
  id: number
  title: string
  /** Public source page, e.g. https://nhentai.net/g/{id}/ */
  url: string
  /** ONLY the first page/cover image. The feed never carries the rest
   * of the gallery; full page lists are fetched separately, on demand,
   * via GET /api/sauce/{id}/pages when the user pages through a sauce. */
  firstImageUrl: string | null
}
