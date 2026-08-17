import {
  SEARCH_DEBOUNCE_MS,
  searchProfiles,
  shouldSuggestProfiles,
  suggestionValue,
  type ProfileSuggestion,
} from './profile-search'

export function attachIdentityCombobox(input: HTMLInputElement): () => void {
  const root = document.createElement('div')
  root.className = 'identity-combobox'
  input.parentNode?.insertBefore(root, input)
  root.append(input)

  const listbox = document.createElement('ul')
  listbox.className = 'suggest-list'
  listbox.id = 'identity-suggestions'
  listbox.setAttribute('role', 'listbox')
  listbox.hidden = true
  root.append(listbox)

  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-expanded', 'false')
  input.setAttribute('aria-controls', listbox.id)
  input.setAttribute('aria-activedescendant', '')

  let suggestions: ProfileSuggestion[] = []
  let activeIndex = -1
  let debounceTimer: number | undefined
  let searchAbort: AbortController | undefined
  let searchGeneration = 0

  const cleanupFns: Array<() => void> = []

  function setExpanded(open: boolean) {
    input.setAttribute('aria-expanded', open ? 'true' : 'false')
    listbox.hidden = !open
  }

  function clearActiveOption() {
    activeIndex = -1
    input.setAttribute('aria-activedescendant', '')
    for (const option of listbox.querySelectorAll('.suggest-option')) {
      option.classList.remove('active')
      option.setAttribute('aria-selected', 'false')
    }
  }

  function closeSuggestions() {
    window.clearTimeout(debounceTimer)
    debounceTimer = undefined
    searchAbort?.abort()
    searchAbort = undefined
    searchGeneration++
    suggestions = []
    clearActiveOption()
    listbox.replaceChildren()
    setExpanded(false)
  }

  function selectSuggestion(index: number) {
    const suggestion = suggestions[index]
    if (!suggestion) return
    input.value = suggestionValue(suggestion)
    closeSuggestions()
    input.focus()
  }

  function renderSuggestions(items: ProfileSuggestion[]) {
    suggestions = items
    clearActiveOption()
    listbox.replaceChildren()

    if (items.length === 0) {
      setExpanded(false)
      return
    }

    for (const [index, item] of items.entries()) {
      const option = document.createElement('li')
      option.id = `identity-suggestion-${index}`
      option.className = 'suggest-option'
      option.setAttribute('role', 'option')
      option.setAttribute('aria-selected', 'false')

      if (item.picture) {
        const avatar = document.createElement('img')
        avatar.className = 'suggest-avatar'
        avatar.src = item.picture
        avatar.alt = ''
        avatar.referrerPolicy = 'no-referrer'
        avatar.decoding = 'async'
        avatar.addEventListener('error', () => avatar.remove())
        option.append(avatar)
      } else {
        const placeholder = document.createElement('span')
        placeholder.className = 'suggest-avatar suggest-avatar-empty'
        placeholder.setAttribute('aria-hidden', 'true')
        option.append(placeholder)
      }

      const copy = document.createElement('span')
      copy.className = 'suggest-copy'

      const name = document.createElement('span')
      name.className = 'suggest-name'
      name.textContent = item.displayName?.trim() || item.npub.slice(0, 16) + '…'

      copy.append(name)

      if (item.nip05) {
        const handle = document.createElement('span')
        handle.className = 'suggest-handle'
        handle.textContent = item.nip05
        copy.append(handle)
      }

      option.append(copy)

      option.addEventListener('mousedown', (event) => {
        event.preventDefault()
      })
      option.addEventListener('click', () => selectSuggestion(index))

      listbox.append(option)
    }

    setExpanded(true)
  }

  function setActiveOption(index: number) {
    if (suggestions.length === 0) return

    const next =
      ((index % suggestions.length) + suggestions.length) % suggestions.length
    activeIndex = next

    for (const [i, option] of [
      ...listbox.querySelectorAll<HTMLElement>('.suggest-option'),
    ].entries()) {
      const selected = i === next
      option.classList.toggle('active', selected)
      option.setAttribute('aria-selected', selected ? 'true' : 'false')
      if (selected) {
        input.setAttribute('aria-activedescendant', option.id)
        option.scrollIntoView({ block: 'nearest' })
      }
    }
  }

  async function runSearch(query: string) {
    searchAbort?.abort()
    if (!shouldSuggestProfiles(query)) {
      closeSuggestions()
      return
    }

    const controller = new AbortController()
    searchAbort = controller
    const generation = ++searchGeneration

    suggestions = []
    clearActiveOption()
    listbox.replaceChildren()
    const loading = document.createElement('li')
    loading.className = 'suggest-status'
    loading.textContent = 'Searching profiles…'
    listbox.append(loading)
    setExpanded(true)

    const results = await searchProfiles(query, {
      signal: controller.signal,
    })

    if (generation !== searchGeneration || controller.signal.aborted) return
    renderSuggestions(results)
  }

  function scheduleSearch() {
    window.clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(() => {
      void runSearch(input.value)
    }, SEARCH_DEBOUNCE_MS)
  }

  const onInput = () => scheduleSearch()
  input.addEventListener('input', onInput)
  cleanupFns.push(() => input.removeEventListener('input', onInput))

  const onFormSubmit = () => {
    if (listbox.hidden || activeIndex < 0) return
    const suggestion = suggestions[activeIndex]
    if (!suggestion) return
    input.value = suggestionValue(suggestion)
    closeSuggestions()
  }
  input.form?.addEventListener('submit', onFormSubmit, { capture: true })
  cleanupFns.push(() =>
    input.form?.removeEventListener('submit', onFormSubmit, { capture: true }),
  )

  const onKeyDown = (event: KeyboardEvent) => {
    if (listbox.hidden) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveOption(activeIndex + 1)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveOption(activeIndex <= 0 ? suggestions.length - 1 : activeIndex - 1)
      return
    }

    if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault()
      selectSuggestion(activeIndex)
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      closeSuggestions()
    }
  }
  input.addEventListener('keydown', onKeyDown)
  cleanupFns.push(() => input.removeEventListener('keydown', onKeyDown))

  const onBlur = () => {
    window.setTimeout(() => {
      if (!root.contains(document.activeElement)) {
        closeSuggestions()
      }
    }, 120)
  }
  input.addEventListener('blur', onBlur)
  cleanupFns.push(() => input.removeEventListener('blur', onBlur))

  return () => {
    window.clearTimeout(debounceTimer)
    searchAbort?.abort()
    for (const fn of cleanupFns) fn()
    closeSuggestions()
    root.replaceWith(input)
  }
}
