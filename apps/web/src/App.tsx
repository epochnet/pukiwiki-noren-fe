import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { useApi } from './api.ts';
import { Layout } from './components/Layout.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { PageRoute } from './pages/PageRoute.tsx';
import { NewPage } from './pages/NewPage.tsx';
import { SearchPage } from './pages/SearchPage.tsx';
import { RecentPage, AllPages, FilesPage, OrphansPage, DeletedPage } from './pages/Lists.tsx';
import { CalendarPage } from './pages/CalendarPage.tsx';
import { ProposalPage } from './pages/ProposalPage.tsx';
import { AdminPage } from './pages/AdminPage.tsx';

function RootRedirect() {
  const { data, error } = useApi<any[]>('/api/wikis');
  if (error) return <div className="main"><h1>接続できません</h1><p>{error.message}</p></div>;
  if (!data) return <div className="main" aria-busy="true">読み込み中…</div>;
  if (!data.length) return <div className="main"><h1>Wiki が設定されていません</h1></div>;
  return <Navigate to={`/w/${encodeURIComponent(data[0].id)}`} replace />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/w/:wiki" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="p/*" element={<PageRoute />} />
          <Route path="new" element={<NewPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="recent" element={<RecentPage />} />
          <Route path="pages" element={<AllPages />} />
          <Route path="files" element={<FilesPage />} />
          <Route path="orphans" element={<OrphansPage />} />
          <Route path="deleted" element={<DeletedPage />} />
          <Route path="calendar/*" element={<CalendarPage />} />
          <Route path="proposals/:id" element={<ProposalPage />} />
          <Route path="admin" element={<AdminPage />} />
        </Route>
        <Route path="*" element={<RootRedirect />} />
      </Routes>
    </BrowserRouter>
  );
}
