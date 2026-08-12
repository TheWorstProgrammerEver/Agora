import { Navigate, Route, Routes } from 'react-router-dom'
import { AgoraAppFrame } from './components/AgoraAppFrame/AgoraAppFrame'
import { RequireAuth } from './routing/RequireAuth'
import { AuthScreen } from './screens/AuthScreen/AuthScreen'
import { HomeScreen } from './screens/HomeScreen/HomeScreen'
import { GroupScreen } from './screens/GroupScreen/GroupScreen'
import { ProfileScreen } from './screens/ProfileScreen/ProfileScreen'
import { AuthContextProvider } from './contexts/AuthContext'

export const App = () => (
  <AuthContextProvider>
    <Routes>
      <Route path="/sign-in" element={<AuthScreen />} />
      <Route element={<RequireAuth />}>
        <Route element={<AgoraAppFrame />}>
          <Route index element={<HomeScreen />} />
          <Route path="groups/:groupId" element={<GroupScreen />} />
          <Route path="profile" element={<ProfileScreen />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </AuthContextProvider>
)
