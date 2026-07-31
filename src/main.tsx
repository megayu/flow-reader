import './styles.css'

import { createRoot } from 'react-dom/client'

import { FlowReader } from './app/FlowReader'

const root = document.getElementById('root')
if (!root) throw new Error('Flow Reader root element was not found')

createRoot(root).render(<FlowReader />)
