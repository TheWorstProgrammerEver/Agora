# Dispatch

A tiny request dispatcher for command/query style boundaries.

Use it when the caller should describe _what_ it wants, while another layer decides _how_ to handle it. This is useful for keeping UI code, data access, and backend function handlers loosely connected.

## Example

```ts
import {
  createCommandType,
  createDispatcher,
  createQueryType,
  createRequestHandler,
  createRequestHandlers
} from './dispatch'

type Project = {
  id: string
  name: string
}

type ProjectStore = {
  projects: Project[]
}

const ListProjectsQuery = createQueryType('projects.list')<Project[]>()
const RenameProjectCommand = createCommandType('projects.rename')<Project, {
  id: string
  name: string
}>()

const createProjectHandlers = (store: ProjectStore) => createRequestHandlers([
  createRequestHandler(ListProjectsQuery, () => store.projects),

  createRequestHandler(RenameProjectCommand, (request) => {
    const { id, name } = request.params
    const project = store.projects.find((candidate) => candidate.id === id)

    if (!project) {
      throw new Error('Project not found.')
    }

    project.name = name

    return project
  })
])

const store = {
  projects: [
    { id: 'project_1', name: 'First project' }
  ]
}
const dispatcher = createDispatcher(createProjectHandlers(store))

const projects = await dispatcher.dispatch(new ListProjectsQuery())
const renamedProject = await dispatcher.dispatch(new RenameProjectCommand({
  id: 'project_1',
  name: 'Renamed project'
}))
```

## Shape

Requests are plain objects with:

- `identifier`: a stable key used to find the handler.
- `params`: the request input.
- `resultType`: a compile-time-only field that lets TypeScript remember the expected result type.

`createQueryType` and `createCommandType` both create request classes. The runtime behavior is the same; the distinction is for readability:

- Queries ask for data.
- Commands ask for a change.

Generated request classes also expose their stable identifier as a static property:

```ts
ListProjectsQuery.identifier === 'projects.list'
```

Prefer `createRequestHandler` for request-specific handlers. It registers the handler under the request type's identifier and gives `request.params` the correct type inside the handler.

Handlers are ultimately registered as a `Record<string, RequestHandler>`. The dispatcher looks up `request.identifier`, calls the matching handler, and returns the handler result typed as the request result.

## Typical Use

```ts
const dispatcher = createDispatcher(createRequestHandlers([
  createRequestHandler(SomeQuery, createSomeQueryHandler(dependencies)),
  createRequestHandler(SomeCommand, createSomeCommandHandler(dependencies))
]))

const result = await dispatcher.dispatch(new SomeQuery({ id: '123' }))
```

Keep request identifiers stable if they cross a network or persistence boundary. For in-process-only dispatchers, they just need to be unique inside that dispatcher.

## Why Not Decorators?

Decorators can attach metadata to classes, but they do not improve the handler's parameter/result inference by themselves. A static `identifier` on the generated request class gives the same runtime benefit with less TypeScript configuration and less ceremony.
