import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import RWPage from './RWPage';
import ImagePage from './ImagePage';
import PDFPage from './PDFPage';
import Sidebar from './Sidebar';
import Generate from './Generate';
import Regenerate from './Regenerate';
import { AppProvider } from './AppContext';

function App() {
  return (
    <AppProvider>
      <Router>
        <div className="flex h-screen bg-slate-950 text-slate-100">
          <Sidebar />
          <main className="flex-1 overflow-hidden">
            <Routes>
              <Route path="/" element={<RWPage />} />
              <Route path="/image" element={<ImagePage />} />
              <Route path="/pdf" element={<PDFPage />} />
              <Route path="/generate" element={<Generate />} />
              <Route path="/regenerate" element={<Regenerate />} />
            </Routes>
          </main>
        </div>
      </Router>
    </AppProvider>
  );
}

export default App;
