// PostgREST-shaped offline client: selected JSON paths are projected before return.
export function queryFixture(tables, { beforeRead = () => {} } = {}) {
  const reads = []
  const client = {
    reads,
    from(table) {
      const filters = [], orders = []
      let fields = "*", limit = Infinity, offset = 0
      const execute = () => {
        beforeRead({ table, fields, reads })
        let rows = (tables[table] || []).filter(row => filters.every(fn => fn(row)))
        rows = [...rows].sort((a, b) => {
          for (const [key, ascending] of orders) {
            const cmp = String(a[key]).localeCompare(String(b[key]))
            if (cmp) return ascending ? cmp : -cmp
          }
          return 0
        }).slice(offset, offset + limit)
        const data = rows.map(row => fields === "*" ? { ...row } : Object.fromEntries(
          fields.split(",").map(field => {
            const [alias, expression] = field.trim().includes(":") ? field.trim().split(":") : [null, field.trim()]
            const [root, ...path] = expression.split("->")
            const value = path.reduce((value, key) => value?.[key], row[root])
            return [alias || expression, value ?? null]
          })
        ))
        reads.push({ table, fields, data })
        return { data, error: null }
      }
      const q = {
        select(value) { fields = value; return q },
        eq(key, value) { filters.push(row => row[key] === value); return q },
        is(key, value) { filters.push(row => row[key] === value); return q },
        in(key, values) { filters.push(row => values.includes(row[key])); return q },
        gte(key, value) { filters.push(row => row[key] >= value); return q },
        order(key, { ascending = true } = {}) { orders.push([key, ascending]); return q },
        limit(value) { limit = value; return q },
        range(start, end) { offset = start; limit = end - start + 1; return q },
        maybeSingle() { const result = execute(); return Promise.resolve({ ...result, data: result.data[0] || null }) },
        then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject) },
      }
      return q
    },
  }
  return client
}
