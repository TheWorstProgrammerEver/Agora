import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuthContext } from '../contexts/AuthContext'

export const RequireAuth = () => {
  const location = useLocation()
  const { authReady, currentAccount } = useAuthContext()

  if (!authReady) {
    return null
  }

  return currentAccount
    ? <Outlet />
    : <Navigate to="/sign-in" replace state={{ returnTo: `${location.pathname}${location.search}` }} />
}
