export function stripLeadingSqlComments(sql) {
  let text = String(sql ?? '').trimStart()

  while (text) {
    if (text.startsWith('--') || text.startsWith('#')) {
      const newline = text.indexOf('\n')
      text = newline >= 0 ? text.slice(newline + 1).trimStart() : ''
      continue
    }

    if (text.startsWith('/*')) {
      const end = text.indexOf('*/', 2)
      if (end < 0) return ''
      text = text.slice(end + 2).trimStart()
      continue
    }

    break
  }

  return text
}
