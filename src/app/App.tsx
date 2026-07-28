import { NotificationProvider } from '../components/ui/notification'
import { LibraryPage } from '../library/LibraryPage'

export default function App() {
  return (
    <NotificationProvider>
      <LibraryPage />
    </NotificationProvider>
  )
}
